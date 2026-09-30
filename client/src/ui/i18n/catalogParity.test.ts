// ui/i18n/catalogParity.test.ts — the §5.3 parity gate: PARITY-01..04 (I18N-26/27/28) + the
// per-locale plural-category shape + the `fr` runtime proof.
//
// ZERO RegExp anywhere in this file: every scan below is `String.indexOf` /
// `charCodeAt` / a hand-rolled char-class walk, same discipline as `catalogShape.test.ts`.
//
// Every BAD/GOOD/vacuity fixture is asserted EXACTLY ONCE — no gate-auditing-the-gate, no
// fixture reused across two assertions to inflate apparent coverage. Every assertion message
// below names the WRONG IMPLEMENTATION it kills.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The comment stripper is IMPORTED, never copied (ADR-0215 single-owner rule). Same path as
// catalogShape.test.ts:35.
import { stripComments } from '../../../test-util/stripComments';
import { a11yCopy } from '../a11yCopy';
import { CATALOG_EN } from './catalog.en';
// NO import of './catalog.fr' — see the header. `CATALOGS`, `t`, `tf`, `setLocale`,
// `currentLocale` are the resolver's public surface; `CATALOGS.fr` is read
// dynamically below, which is `undefined` at HEAD (Catalog | undefined via the index type).
import { CATALOGS, currentLocale, setLocale, t, tf } from './resolver';

const I18N_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = path.resolve(I18N_DIR, '..', '..');
const MESSAGE_IDS_PATH = path.join(I18N_DIR, 'messageIds.ts');

// ---------------------------------------------------------------------------
// Shared char-class primitives (no RegExp).
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

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The code-context scanner (R1). Extends `catalogShape.test.ts`'s comment/string mask with
// TEMPLATE-LITERAL INTERPOLATION: a `${…}` payload inside a backtick is CODE, recursively (a
// call inside it is scannable), while the surrounding backtick TEXT stays literal (masked). Runs
// on already comment-stripped source (via the imported `stripComments`), so it needs no
// comment states of its own — only string/template states plus a stack of open template /
// interpolation frames.
// ---------------------------------------------------------------------------

type InterpFrame = { readonly kind: 'interp'; braceDepth: number };
type TemplateFrame = { readonly kind: 'template' };
type Frame = InterpFrame | TemplateFrame;

/** codeContextAt[i] === true iff position i (in already comment-stripped `stripped`) is reached
 *  in genuine CODE context: not inside a single/double-quoted string, and not inside backtick TEXT
 *  that is outside any `${…}` interpolation. Inside a `${…}` interpolation — at any nesting depth
 *  — is CODE (R1's fix): a checker without this recursion never finds a call planted inside a
 *  template's interpolation and silently reports zero findings for it. */
function computeCodeContext(stripped: string): boolean[] {
  const n = stripped.length;
  const codeContextAt: boolean[] = new Array<boolean>(n).fill(false);
  const stack: Frame[] = [];
  let state: 'code' | 'sq' | 'dq' = 'code';
  let i = 0;
  while (i < n) {
    const top = stack.length > 0 ? stack[stack.length - 1] : undefined;
    const inTemplateText = state === 'code' && top !== undefined && top.kind === 'template';
    codeContextAt[i] = state === 'code' && !inTemplateText;
    const ch = stripped.charAt(i);
    const next = i + 1 < n ? stripped.charAt(i + 1) : '';

    if (state === 'sq' || state === 'dq') {
      if (ch === '\\' && i + 1 < n) {
        i += 2;
        continue;
      }
      if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"')) state = 'code';
      i += 1;
      continue;
    }

    // state === 'code'
    if (inTemplateText) {
      if (ch === '\\' && i + 1 < n) {
        i += 2;
        continue;
      }
      if (ch === '$' && next === '{') {
        stack.push({ kind: 'interp', braceDepth: 0 });
        i += 2;
        continue;
      }
      if (ch === '`') {
        stack.pop();
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === "'") {
      state = 'sq';
      i += 1;
      continue;
    }
    if (ch === '"') {
      state = 'dq';
      i += 1;
      continue;
    }
    if (ch === '`') {
      stack.push({ kind: 'template' });
      i += 1;
      continue;
    }
    if (top !== undefined && top.kind === 'interp') {
      if (ch === '{') {
        (top as InterpFrame).braceDepth += 1;
        i += 1;
        continue;
      }
      if (ch === '}') {
        if (top.braceDepth === 0) {
          stack.pop();
          i += 1;
          continue;
        }
        (top as InterpFrame).braceDepth -= 1;
        i += 1;
        continue;
      }
    }
    i += 1;
  }
  return codeContextAt;
}

// ---------------------------------------------------------------------------
// Import-binding resolution (R3/R4/R5): local -> {module, orig}.
// ---------------------------------------------------------------------------

interface ImportBinding {
  readonly local: string;
  readonly module: 'i18n' | 'a11y';
  readonly orig: 't' | 'tf';
}

/** R4: `/i18n/resolver`, `/i18n/resolver.ts`, `/i18n/resolver.js`, `./resolver`, `./resolver.ts`,
 *  `./resolver.js` are all accepted; a re-export or a dynamic `import()` is an accepted limit
 *  (recorded in ADR-0263), never scanned. */
function isResolverSpecifier(spec: string): boolean {
  if (spec === './resolver' || spec === './resolver.ts' || spec === './resolver.js') return true;
  return (
    endsWith(spec, '/i18n/resolver') ||
    endsWith(spec, '/i18n/resolver.ts') ||
    endsWith(spec, '/i18n/resolver.js')
  );
}

function isA11ySpecifier(spec: string): boolean {
  if (spec === '../a11yCopy' || spec === '../a11yCopy.ts' || spec === '../a11yCopy.js') return true;
  return (
    endsWith(spec, '/a11yCopy') || endsWith(spec, '/a11yCopy.ts') || endsWith(spec, '/a11yCopy.js')
  );
}

/** Splits `list` on top-level commas — the import-brace body has no nested braces/parens, so a
 *  plain split is exact. Drops empty (trailing-comma) segments. */
function splitTopLevelCommas(list: string): string[] {
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < list.length; i++) {
    const ch = list.charAt(i);
    if (ch === ',') {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.filter((s) => s.trim().length > 0);
}

/** Reads the next whitespace-delimited identifier token starting at `i` (after skipping leading
 *  whitespace); returns `{ token, next }` where `next` is the index right after the token. */
function readToken(s: string, start: number): { token: string; next: number } {
  let i = start;
  while (i < s.length && isWhitespace(s.charAt(i))) i += 1;
  let token = '';
  while (i < s.length && isIdentChar(s.charAt(i))) {
    token += s.charAt(i);
    i += 1;
  }
  return { token, next: i };
}

/** Parses one import-list entry (`t`, `t as i18nT`, `type Catalog`, `type Catalog as C`). Returns
 *  `undefined` for a `type`-prefixed entry (R3/R4 belt: type items are IGNORED, never bound). */
function parseImportEntry(entry: string): { orig: string; local: string } | undefined {
  const first = readToken(entry, 0);
  if (first.token === 'type') return undefined; // single-item type-only import
  const maybeAs = readToken(entry, first.next);
  if (maybeAs.token === 'as') {
    const local = readToken(entry, maybeAs.next);
    return { orig: first.token, local: local.token };
  }
  return { orig: first.token, local: first.token };
}

/** Parses ONE `import …` declaration starting right after the `import` keyword (`afterImport`).
 *  Returns the index right after the statement's terminating `;` (or EOF) plus the extracted
 *  bindings for the i18n/a11y modules ONLY (every other specifier's entries are dropped — this
 *  census has no use for them). Quote-aware brace-depth scan for the statement end (R3: a
 *  multi-line `{ … }` list must not truncate the statement at an internal `;`-free newline). */
function parseImportStatement(
  stripped: string,
  afterImport: number,
): { end: number; bindings: ImportBinding[] } {
  const n = stripped.length;
  let state: 'code' | 'sq' | 'dq' = 'code';
  let depth = 0;
  let end = n;
  let j = afterImport;
  while (j < n) {
    const ch = stripped.charAt(j);
    if (state === 'sq' || state === 'dq') {
      if (ch === '\\' && j + 1 < n) {
        j += 2;
        continue;
      }
      if ((state === 'sq' && ch === "'") || (state === 'dq' && ch === '"')) state = 'code';
      j += 1;
      continue;
    }
    if (ch === "'") {
      state = 'sq';
      j += 1;
      continue;
    }
    if (ch === '"') {
      state = 'dq';
      j += 1;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      j += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      j += 1;
      continue;
    }
    if (ch === ';' && depth <= 0) {
      end = j;
      break;
    }
    j += 1;
  }
  const raw = stripped.slice(afterImport, end);

  // Whole-declaration type-only import (`import type { … } from '…'` / `import type X from '…'`):
  // no runtime binding exists at all — skip entirely (R3/R4 belt).
  const leading = readToken(raw, 0);
  if (leading.token === 'type') return { end: end + 1, bindings: [] };

  const braceStart = raw.indexOf('{');
  const braceEnd = raw.indexOf('}');
  const specFrom = raw.indexOf('from');
  if (specFrom === -1) return { end: end + 1, bindings: [] };
  let k = specFrom + 'from'.length;
  while (k < raw.length && isWhitespace(raw.charAt(k))) k += 1;
  const quote = raw.charAt(k);
  let specifier = '';
  if (quote === "'" || quote === '"') {
    let m = k + 1;
    while (m < raw.length && raw.charAt(m) !== quote) {
      specifier += raw.charAt(m);
      m += 1;
    }
  }

  const bindings: ImportBinding[] = [];
  const module: 'i18n' | 'a11y' | undefined = isResolverSpecifier(specifier)
    ? 'i18n'
    : isA11ySpecifier(specifier)
      ? 'a11y'
      : undefined;
  if (module === undefined) return { end: end + 1, bindings: [] };
  if (braceStart === -1 || braceEnd === -1 || braceEnd < braceStart)
    return { end: end + 1, bindings: [] };

  const listBody = raw.slice(braceStart + 1, braceEnd);
  for (const rawEntry of splitTopLevelCommas(listBody)) {
    const parsed = parseImportEntry(rawEntry);
    if (parsed === undefined) continue;
    if (module === 'i18n' && (parsed.orig === 't' || parsed.orig === 'tf')) {
      bindings.push({ local: parsed.local, module: 'i18n', orig: parsed.orig });
    } else if (module === 'a11y' && parsed.orig === 't') {
      bindings.push({ local: parsed.local, module: 'a11y', orig: 't' });
    }
  }
  return { end: end + 1, bindings };
}

/** Walks `stripped` for every top-level `import` keyword and returns every i18n/a11y binding it
 *  establishes. Multi-line lists (R3) and `.ts`/`.js`-suffixed specifiers (R4) resolve because
 *  `parseImportStatement` scans forward to the statement's own `;`, not to end-of-line. */
function parseImportBindings(stripped: string): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  const n = stripped.length;
  let i = 0;
  while (i < n) {
    const at = stripped.indexOf('import', i);
    if (at === -1) break;
    const before = at > 0 ? stripped.charAt(at - 1) : '';
    const afterIdx = at + 'import'.length;
    const after = afterIdx < n ? stripped.charAt(afterIdx) : '';
    if (isIdentChar(before) || isIdentChar(after)) {
      i = afterIdx;
      continue;
    }
    const { end, bindings: found } = parseImportStatement(stripped, afterIdx);
    bindings.push(...found);
    i = end;
  }
  return bindings;
}

// ---------------------------------------------------------------------------
// Call-site scanning: literal vs. DYNAMIC-KEY (R1/R2/R5).
// ---------------------------------------------------------------------------

interface CallSite {
  readonly index: number;
  readonly kind: 'literal' | 'dynamic';
  readonly literal: string | undefined;
}

/** Finds every call to `localName` in `stripped`, using `codeContextAt` to skip string/template
 *  TEXT payload (never a real call) and to admit `${…}` interpolation interiors (R1). A `.`
 *  receiver (`obj.t(`) is NOT a binding call (an accepted limit, X2) and is skipped. An optional
 *  generic `<...>` argument list and an optional `?.` (R2) before `(` are both tolerated. */
function findCalls(
  stripped: string,
  codeContextAt: readonly boolean[],
  localName: string,
): CallSite[] {
  const calls: CallSite[] = [];
  const n = stripped.length;
  let i = 0;
  while (i < n) {
    const at = stripped.indexOf(localName, i);
    if (at === -1) break;
    const before = at > 0 ? stripped.charAt(at - 1) : '';
    const afterIdx = at + localName.length;
    const after = afterIdx < n ? stripped.charAt(afterIdx) : '';
    if (isIdentChar(before) || isIdentChar(after) || before === '.' || !codeContextAt[at]) {
      i = afterIdx;
      continue;
    }
    let j = afterIdx;
    while (j < n && isWhitespace(stripped.charAt(j))) j += 1;
    if (stripped.charAt(j) === '<') {
      let depth = 0;
      while (j < n) {
        const ch = stripped.charAt(j);
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
      while (j < n && isWhitespace(stripped.charAt(j))) j += 1;
    }
    if (stripped.charAt(j) === '?' && stripped.charAt(j + 1) === '.') {
      j += 2;
      while (j < n && isWhitespace(stripped.charAt(j))) j += 1;
    }
    if (stripped.charAt(j) !== '(') {
      i = afterIdx;
      continue;
    }
    j += 1;
    while (j < n && isWhitespace(stripped.charAt(j))) j += 1;
    const quote = stripped.charAt(j);
    if (quote === "'" || quote === '"') {
      let k = j + 1;
      let text = '';
      while (k < n && stripped.charAt(k) !== quote) {
        if (stripped.charAt(k) === '\\' && k + 1 < n) {
          text += stripped.charAt(k + 1);
          k += 2;
          continue;
        }
        text += stripped.charAt(k);
        k += 1;
      }
      let m = k + 1;
      while (m < n && isWhitespace(stripped.charAt(m))) m += 1;
      const nextCh = stripped.charAt(m);
      if (nextCh === ',' || nextCh === ')') {
        calls.push({ index: at, kind: 'literal', literal: text });
      } else {
        // R5: `'a.b' as const` / `('a.b')` / `'a.b' satisfies X` all land here — safe direction.
        calls.push({ index: at, kind: 'dynamic', literal: undefined });
      }
    } else {
      // Any backtick, identifier, expression, or empty argument list — always DYNAMIC-KEY.
      calls.push({ index: at, kind: 'dynamic', literal: undefined });
    }
    i = afterIdx;
  }
  return calls;
}

// ---------------------------------------------------------------------------
// Per-source pipeline (shared by the live tree walk and every fixture).
// ---------------------------------------------------------------------------

interface CallRecord {
  readonly module: 'i18n' | 'a11y';
  readonly orig: 't' | 'tf';
  readonly kind: 'literal' | 'dynamic';
  readonly literal: string | undefined;
}

function censusOfSource(raw: string): { bindings: ImportBinding[]; calls: CallRecord[] } {
  const stripped = stripComments(raw);
  const bindings = parseImportBindings(stripped);
  if (bindings.length === 0) return { bindings: [], calls: [] };
  const codeContextAt = computeCodeContext(stripped);
  const calls: CallRecord[] = [];
  for (const b of bindings) {
    for (const c of findCalls(stripped, codeContextAt, b.local)) {
      calls.push({ module: b.module, orig: b.orig, kind: c.kind, literal: c.literal });
    }
  }
  return { bindings, calls };
}

interface FileCensus {
  readonly file: string;
  readonly bindings: ImportBinding[];
  readonly calls: CallRecord[];
}

function walkClientSrc(dir: string, base: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = base === '' ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) {
      walkClientSrc(abs, rel, out);
    } else if (entry.isFile() && endsWith(entry.name, '.ts') && !endsWith(entry.name, '.test.ts')) {
      out.push(rel);
    }
  }
}

let cachedCensus: FileCensus[] | undefined;

/** Memoised: the tree is walked and every non-test `.ts` file read/parsed exactly once. */
function computeCensus(): FileCensus[] {
  if (cachedCensus) return cachedCensus;
  const files: string[] = [];
  walkClientSrc(CLIENT_SRC, '', files);
  files.sort();
  const out: FileCensus[] = [];
  for (const rel of files) {
    const raw = readFileSync(path.join(CLIENT_SRC, ...rel.split('/')), 'utf8');
    const { bindings, calls } = censusOfSource(raw);
    out.push({ file: rel, bindings, calls });
  }
  cachedCensus = out;
  return out;
}

// ---------------------------------------------------------------------------
// MessageId union belt (parsed from messageIds.ts source, not from the type system).
// ---------------------------------------------------------------------------

/** Parses `export type MessageId = … ;` — the FIRST occurrence only (stops at the first `;`
 *  reached after the marker, so a decoy second `export type MessageId =` block below is never
 *  parsed) — collecting every `| '<key>'` line. Runs on comment-STRIPPED source, so a commented
 *  `| 'dead.x'` row was already removed and is never seen. */
function parseMessageIdUnion(src: string): string[] {
  const stripped = stripComments(src);
  const marker = 'export type MessageId =';
  const startIdx = stripped.indexOf(marker);
  if (startIdx === -1) return [];
  const endIdx = stripped.indexOf(';', startIdx);
  const body = endIdx === -1 ? stripped.slice(startIdx) : stripped.slice(startIdx, endIdx);
  const ids: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!startsWith(trimmed, "| '")) continue;
    const rest = trimmed.slice("| '".length);
    const closeIdx = rest.indexOf("'");
    if (closeIdx === -1) continue;
    ids.push(rest.slice(0, closeIdx));
  }
  return ids;
}

// ---------------------------------------------------------------------------
// PARITY-01 (I18N-26): key-set parity, both directions, every registered locale.
// ---------------------------------------------------------------------------

interface ParityGapFinding {
  readonly kind: 'PARITY-GAP' | 'EMPTY-REGISTRY';
  readonly locale?: string;
  readonly key?: string;
  readonly direction?: 'missing' | 'extra';
}

function checkKeyParity(
  messageIds: readonly string[],
  catalogs: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): ParityGapFinding[] {
  const locales = Object.keys(catalogs);
  if (locales.length === 0) return [{ kind: 'EMPTY-REGISTRY' }];
  const idSet = new Set(messageIds);
  const findings: ParityGapFinding[] = [];
  for (const locale of locales) {
    const keys = new Set(Object.keys(catalogs[locale]));
    for (const id of messageIds) {
      if (!keys.has(id)) {
        findings.push({ kind: 'PARITY-GAP', locale, key: id, direction: 'missing' });
      }
    }
    for (const key of keys) {
      if (!idSet.has(key)) {
        findings.push({ kind: 'PARITY-GAP', locale, key, direction: 'extra' });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// PARITY-03/UNDEFINED-KEY + PARITY-04/DEAD-KEY classifiers.
// ---------------------------------------------------------------------------

const DEAD_KEY_EXEMPT: readonly string[] = ['chrome.helpHint'];

interface UndefinedKeyFinding {
  readonly kind: 'UNDEFINED-KEY';
  readonly module: 'i18n' | 'a11y';
  readonly key: string;
}

function checkUndefinedKeys(
  calls: readonly CallRecord[],
  messageIds: ReadonlySet<string>,
  a11yKeys: ReadonlySet<string>,
): UndefinedKeyFinding[] {
  const findings: UndefinedKeyFinding[] = [];
  for (const c of calls) {
    if (c.kind !== 'literal' || c.literal === undefined) continue;
    if (c.module === 'i18n' && !messageIds.has(c.literal)) {
      findings.push({ kind: 'UNDEFINED-KEY', module: 'i18n', key: c.literal });
    } else if (c.module === 'a11y' && !a11yKeys.has(c.literal)) {
      findings.push({ kind: 'UNDEFINED-KEY', module: 'a11y', key: c.literal });
    }
  }
  return findings;
}

interface DeadKeyFinding {
  readonly kind: 'DEAD-KEY' | 'STALE-EXEMPTION';
  readonly key: string;
}

function checkDeadKeys(
  messageIds: readonly string[],
  requested: ReadonlySet<string>,
  exempt: readonly string[],
): DeadKeyFinding[] {
  const exemptSet = new Set(exempt);
  const findings: DeadKeyFinding[] = [];
  for (const id of messageIds) {
    const isRequested = requested.has(id);
    if (exemptSet.has(id)) {
      if (isRequested) findings.push({ kind: 'STALE-EXEMPTION', key: id });
    } else if (!isRequested) {
      findings.push({ kind: 'DEAD-KEY', key: id });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Plural-category table.
// ---------------------------------------------------------------------------

const PLURAL_CATEGORIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  en: ['one', 'other'],
  fr: ['one', 'many', 'other'],
});

// ---------------------------------------------------------------------------
// Proxy field-set equality (FR-01, R7).
// ---------------------------------------------------------------------------

// battle.weather.banner is the ONE key this slice authors through the plural seam (ADR-0263 D6,
// plan §1 "DECISION (option B)"); its fr closure calls `selectPlural('fr', p.turns, …)`, which
// needs a genuine NUMBER for `p.turns` — feeding it a string sentinel would make
// `Intl.PluralRules.prototype.select` misbehave. FR-02 owns this key's real plural proof, so the
// generic Proxy-based field-set loop below excludes it and uses concrete params instead.
const PLURAL_PARAM_KEYS: ReadonlySet<string> = new Set(['battle.weather.banner']);

function makeFieldTrackingProxy(family: string, accessed: Set<string>): Record<string, unknown> {
  return new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'string') accessed.add(prop);
        return `${family}::${String(prop)}`;
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('catalogParity (M24 S7, ADR-0263 §5.3)', () => {
  it('m24s7 PARITY-01: I18N-26 — key-set parity, both directions, every registered locale', () => {
    const messageIds = parseMessageIdUnion(readFileSync(MESSAGE_IDS_PATH, 'utf8'));
    expect(messageIds.length, 'the MessageId belt must parse >100 entries').toBeGreaterThan(100);
    expect(
      messageIds.length,
      'the MessageId belt must equal Object.keys(CATALOG_EN).length — a parser that stops early ' +
        'or double-counts a line diverges from the real catalog roster',
    ).toBe(Object.keys(CATALOG_EN as Record<string, unknown>).length);

    // WRONG IMPL KILLED: a registry that never widens past `{ en: CATALOG_EN }`.
    expect(
      Object.keys(CATALOGS as Record<string, unknown>).sort(),
      'the registry must be exactly [en, fr] — S7 ships catalog.fr.ts AND registers it',
    ).toEqual(['en', 'fr']);

    const catalogs = CATALOGS as unknown as Readonly<
      Record<string, Readonly<Record<string, unknown>>>
    >;
    const findings = checkKeyParity(messageIds, catalogs);
    expect(findings, `key-parity findings: ${JSON.stringify(findings)}`).toEqual([]);
  });

  it('m24s7 PARITY-01: fixtures — proof-of-teeth for key-set parity + the union parser', () => {
    const ids = ['a.one', 'a.two', 'a.three'];

    // BAD: fr is missing one key — kills a checker that only walks the union, never the
    // catalog's own key set.
    const missing = checkKeyParity(ids, { fr: { 'a.one': 'x', 'a.two': 'y' } });
    expect(
      missing,
      'a catalog missing one MessageId must report exactly one missing PARITY-GAP',
    ).toEqual([{ kind: 'PARITY-GAP', locale: 'fr', key: 'a.three', direction: 'missing' }]);

    // BAD: fr carries a stowaway key not in the union — kills a checker that only walks the
    // union in ONE direction.
    const extra = checkKeyParity(ids, {
      fr: { 'a.one': 'x', 'a.two': 'y', 'a.three': 'z', 'legacy.old': 'w' },
    });
    expect(
      extra,
      'a stowaway catalog key not in MessageId must report exactly one extra PARITY-GAP',
    ).toEqual([{ kind: 'PARITY-GAP', locale: 'fr', key: 'legacy.old', direction: 'extra' }]);

    // BAD: an empty registry — kills a checker that treats "no locales" as vacuously OK.
    expect(
      checkKeyParity(ids, {}),
      'an empty registry must itself be a finding, never a vacuous pass',
    ).toEqual([{ kind: 'EMPTY-REGISTRY' }]);

    // GOOD: en-only, exact match — zero findings.
    expect(
      checkKeyParity(ids, { en: { 'a.one': 'x', 'a.two': 'y', 'a.three': 'z' } }),
      'an exact single-locale match must produce zero findings',
    ).toEqual([]);

    // Union parser: a decoy SECOND `export type MessageId =` block below the real one must
    // NEVER be parsed — kills a parser that keeps scanning past the first `;`.
    const twoBlocks = [
      'export type MessageId =',
      "  | 'real.one'",
      "  | 'real.two';",
      'export type MessageId =',
      "  | 'decoy.one';",
    ].join('\n');
    expect(
      parseMessageIdUnion(twoBlocks),
      'a second export type MessageId block must never be parsed — only the first counts',
    ).toEqual(['real.one', 'real.two']);

    // Union parser: a commented-out `| 'dead.x'` row inside the union body must not be parsed —
    // kills a parser that scans the RAW (non-comment-stripped) source.
    const withCommentedRow = [
      'export type MessageId =',
      "  | 'alive.one'",
      "  // | 'dead.x'",
      "  | 'alive.two';",
    ].join('\n');
    expect(
      parseMessageIdUnion(withCommentedRow),
      'a commented-out union member must never be parsed',
    ).toEqual(['alive.one', 'alive.two']);
  });

  it('m24s7/21r-b PARITY-02: I18N-27 — import-binding resolution + the 23-file resolver roster + main.ts dual bindings', () => {
    const census = computeCensus();
    const i18nRoster = census
      .filter((f) => f.bindings.some((b) => b.module === 'i18n'))
      .map((f) => f.file)
      .sort();
    // WRONG IMPL KILLED: a bare global `t(`/`tf(` text scan (never resolving import specifiers)
    // would either miss every file (bindings always empty) or over-match unrelated `t(` calls
    // (e.g. `total(`) — the exact 23-file roster below (21r-b added ui/careAction.ts and
    // ui/sessionModel.ts; 21r-b2 adds ui/claimModel.ts and ui/privacyBanner.ts) is only reachable
    // via real binding resolution.
    expect(i18nRoster, `resolver-importing roster: ${JSON.stringify(i18nRoster)}`).toEqual([
      'main.ts',
      'ui/battleView.ts',
      'ui/boxView.ts',
      'ui/careAction.ts',
      'ui/claimModel.ts',
      'ui/claimView.ts',
      'ui/dialogueView.ts',
      'ui/errorOverlayView.ts',
      'ui/evolutionNotice.ts',
      'ui/evolutionView.ts',
      'ui/healView.ts',
      'ui/helpView.ts',
      'ui/leaderboardView.ts',
      'ui/privacyBanner.ts',
      'ui/privacyView.ts',
      'ui/pvpView.ts',
      'ui/questLogView.ts',
      'ui/raisingView.ts',
      'ui/renameView.ts',
      'ui/sessionModel.ts',
      'ui/shopView.ts',
      'ui/tradeProposeView.ts',
      'ui/tradeView.ts',
    ]);

    const main = census.find((f) => f.file === 'main.ts');
    if (main === undefined) throw new Error('main.ts missing from the census walk');
    // main.ts imports a11yCopy's `t` BARE and resolver's `t` ALIASED to `i18nT` — proving the
    // census resolves the two `t` bindings SEPARATELY (a scanner keyed on the literal name `t`
    // alone would conflate them, or miss the aliased one entirely).
    const i18nLiteralKeys = new Set(
      main.calls
        .filter((c) => c.module === 'i18n' && c.kind === 'literal' && c.literal !== undefined)
        .map((c) => c.literal as string),
    );
    // 21r-b adds 9 literal-key call sites in main.ts: the frozen-link disconnected line (shop
    // onBuy/onSell, trade onAccept/onReject/onConfirm/onCancel, tradePropose onSubmit — one
    // literal key, many call sites), the rename-success line, the two shop-outcome lines, the
    // four trade-outcome lines, and the trade-propose "sent" line.
    expect(Array.from(i18nLiteralKeys).sort(), 'main.ts i18n-bound literal keys').toEqual([
      'chrome.feedback.disconnected',
      'chrome.rename.updated',
      'chrome.status.bugBundleBlocked',
      'chrome.status.contentStale',
      'chrome.status.disconnected',
      'chrome.status.exportBlocked',
      'chrome.status.healUnavailable',
      'chrome.status.partyFull',
      'chrome.status.privacyOverlayBusy',
      'shop.feedback.purchased',
      'shop.feedback.sold',
      'trade.feedback.accepted',
      'trade.feedback.cancelled',
      'trade.feedback.completed',
      'trade.feedback.rejected',
      'tradePropose.feedback.sent',
    ]);
    const a11yLiteralKeys = new Set(
      main.calls
        .filter((c) => c.module === 'a11y' && c.kind === 'literal' && c.literal !== undefined)
        .map((c) => c.literal as string),
    );
    expect(Array.from(a11yLiteralKeys).sort(), 'main.ts a11y-bound literal keys').toEqual([
      'a11y.world.region',
    ]);

    // I18N-27 over the LIVE tree: every resolver-bound call's first argument is a literal.
    // WRONG IMPL KILLED (the verifier's own mutant): a roster + main.ts-only assertion lets a call
    // site swap `t('claim.privacyButton')` for a backtick key while a SECOND literal requester of
    // the same key survives — DEAD-KEY never fires, UNDEFINED-KEY never fires, and the whole
    // §5.3 gate stayed green over 3368 tests. The census must be asked directly.
    const dynamicSites = census.flatMap((f) =>
      f.calls.filter((c) => c.kind === 'dynamic').map((c) => `${f.file}:${c.module}.${c.orig}`),
    );
    expect(
      dynamicSites.filter((s) => endsWith(s, ':i18n.t') || endsWith(s, ':i18n.tf')),
      `DYNAMIC-KEY findings over the live tree (i18n binding): ${JSON.stringify(dynamicSites)}`,
    ).toEqual([]);
    // The a11y binding is M23's `t(key: string)` seam, and two of its sites are REGISTRY-DRIVEN by
    // design (`OVERLAY_A11Y[id].labelKey`) — a finding, never a skip: the roster below is
    // exact, so a THIRD dynamic a11y site (or a resolver-bound one) is a loud red, not a pass.
    expect(
      dynamicSites.filter((s) => endsWith(s, ':a11y.t')).sort(),
      'the only dynamic a11y.t sites are the two M23 registry lookups — exact roster',
    ).toEqual(['ui/announcements.ts:a11y.t', 'ui/overlayA11y.ts:a11y.t']);
    const literalTotal = census.reduce(
      (n, f) => n + f.calls.filter((c) => c.kind === 'literal').length,
      0,
    );
    expect(
      literalTotal,
      'anti-vacuity: the live census must classify well over 100 literal call sites',
    ).toBeGreaterThan(100);
  });

  it('m24s7 PARITY-02: fixtures — proof-of-teeth for DYNAMIC-KEY detection + binding resolution', () => {
    // (a) a11y binding, backtick WITH interpolation -> DYNAMIC-KEY.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture IS source text, not a template
    const a = censusOfSource("import { t } from '../a11yCopy';\nt(`a11y.${x}`);");
    expect(a.calls, '(a) a template literal with interpolation must be DYNAMIC-KEY').toEqual([
      { module: 'a11y', orig: 't', kind: 'dynamic', literal: undefined },
    ]);

    // (b) i18n binding, backtick WITHOUT interpolation -> still DYNAMIC-KEY (ANY backtick).
    const b = censusOfSource("import { t } from './i18n/resolver';\nt(`box.title`);");
    expect(
      b.calls,
      '(b) a plain (non-interpolated) template literal must STILL be DYNAMIC-KEY — kills a ' +
        'checker that only flags backticks carrying a dollar-brace placeholder',
    ).toEqual([{ module: 'i18n', orig: 't', kind: 'dynamic', literal: undefined }]);

    // (c) identifier first argument (`as const` variable) -> DYNAMIC-KEY.
    const c = censusOfSource(
      "import { tf } from './i18n/resolver';\nconst k = 'a11y.x' as const;\ntf(k, {});",
    );
    expect(c.calls, '(c) an identifier first argument must be DYNAMIC-KEY').toEqual([
      { module: 'i18n', orig: 'tf', kind: 'dynamic', literal: undefined },
    ]);

    // (d) string concatenation -> DYNAMIC-KEY (R5 safe direction).
    const d = censusOfSource("import { t } from './i18n/resolver';\nt('shop.' + x);");
    expect(
      d.calls,
      "(d) 'shop.' + x concatenation must be DYNAMIC-KEY, never a false LITERAL",
    ).toEqual([{ module: 'i18n', orig: 't', kind: 'dynamic', literal: undefined }]);

    // (e) ternary BETWEEN TWO CALLS (not two keys) — each call is independently literal, so this
    // also proves the scanner does not conflate the ternary's outer shape with either call.
    const e = censusOfSource(
      "import { t } from './i18n/resolver';\nconst s = cond ? t('a.one') : t('a.two');",
    );
    expect(e.calls, '(e) a ternary between two literal calls yields two literal findings').toEqual([
      { module: 'i18n', orig: 't', kind: 'literal', literal: 'a.one' },
      { module: 'i18n', orig: 't', kind: 'literal', literal: 'a.two' },
    ]);

    // (f) GOOD: dynamic PARAMS beside a literal KEY stay literal — only the key is classified.
    const f = censusOfSource(
      "import { tf } from './i18n/resolver';\ntf('leaderboard.row', {...vm});",
    );
    expect(f.calls, '(f) dynamic params must never taint a literal key').toEqual([
      { module: 'i18n', orig: 'tf', kind: 'literal', literal: 'leaderboard.row' },
    ]);

    // (g) decoy: an apostrophe INSIDE a double-quoted string must not desynchronise the sq/dq
    // state machine into reading the "t(" that follows it as a real call.
    const g = censusOfSource("import { t } from './i18n/resolver';\nconst s = \"isn't(x)\";");
    expect(g.calls, '(g) apostrophe-inside-dq must not produce a phantom call').toEqual([]);

    // (h) decoy: a `.`-receiver call is not the binding (accepted limit, X2).
    const h = censusOfSource(
      "import { t } from './i18n/resolver';\nconst obj = { t: (k: string) => k };\nobj.t('a11y.x');",
    );
    expect(h.calls, '(h) a `.`-receiver call must never be counted').toEqual([]);

    // (i) decoy: word-boundary protection against substring false-positives.
    const i = censusOfSource(
      "import { t } from './i18n/resolver';\nconst total = 5;\nconst at = 1;\nconst wait = 2;\n",
    );
    expect(i.calls, "(i) total(/at(/wait( must never match the localName 't'").toEqual([]);

    // (j) dual-import main.ts shape: bare a11y `t` + aliased i18n `i18nT`/`tf`, multi-line list.
    const j = censusOfSource(
      [
        "import { t } from '../a11yCopy';",
        'import {',
        '  CATALOGS,',
        '  t as i18nT,',
        '  tf,',
        "} from './i18n/resolver';",
        "i18nT('chrome.help.title');",
        "t('a11y.world.region');",
        "tf('leaderboard.row', { rating: 1, wins: 0, losses: 0 });",
      ].join('\n'),
    );
    expect(
      j.bindings.slice().sort((x, y) => x.local.localeCompare(y.local)),
      '(j) the dual-import fixture must resolve THREE distinct bindings',
    ).toEqual([
      { local: 'i18nT', module: 'i18n', orig: 't' },
      { local: 't', module: 'a11y', orig: 't' },
      { local: 'tf', module: 'i18n', orig: 'tf' },
    ]);
    expect(j.calls.length, '(j) all three planted calls must be found as LITERAL').toBe(3);
    expect(
      j.calls.every((call) => call.kind === 'literal'),
      '(j) every planted call in the dual-import fixture is a literal',
    ).toBe(true);

    // (k) a file with NO resolver/a11y import produces zero census entries even though its raw
    // text contains `t('x')` — the census never falls back to a bare-global scan.
    const k = censusOfSource("t('x');");
    expect(k.bindings, '(k) no-import file must resolve zero bindings').toEqual([]);
    expect(k.calls, '(k) no-import file must produce zero calls').toEqual([]);

    // (l) `import type { t } from …` is a type-only declaration — it establishes NO runtime
    // binding, so the literal `t('shop.title')` text below it is never scanned.
    const l = censusOfSource("import type { t } from './i18n/resolver';\nt('shop.title');");
    expect(l.bindings, '(l) a type-only import must resolve zero bindings').toEqual([]);
    expect(l.calls, '(l) a type-only import must leave the following calls unscanned').toEqual([]);
  });

  it('m24s7 PARITY-03: I18N-27 — UNDEFINED-KEY is per-binding (i18n vs. a11y), live tree is clean', () => {
    const messageIds = new Set(parseMessageIdUnion(readFileSync(MESSAGE_IDS_PATH, 'utf8')));
    const a11yKeys = new Set(Object.keys(a11yCopy));
    const census = computeCensus();
    const allCalls: CallRecord[] = [];
    for (const f of census) allCalls.push(...f.calls);
    const findings = checkUndefinedKeys(allCalls, messageIds, a11yKeys);
    expect(findings, `live-tree UNDEFINED-KEY findings: ${JSON.stringify(findings)}`).toEqual([]);
  });

  it('m24s7 PARITY-03: fixtures — proof-of-teeth for UNDEFINED-KEY, one finding per fixture', () => {
    const messageIds = new Set(parseMessageIdUnion(readFileSync(MESSAGE_IDS_PATH, 'utf8')));
    const a11yKeys = new Set(Object.keys(a11yCopy));

    // t('shop.notAKey') — i18n binding, not a MessageId.
    const f1 = censusOfSource("import { t } from './i18n/resolver';\nt('shop.notAKey');");
    expect(
      checkUndefinedKeys(f1.calls, messageIds, a11yKeys),
      "t('shop.notAKey') must produce exactly one UNDEFINED-KEY",
    ).toEqual([{ kind: 'UNDEFINED-KEY', module: 'i18n', key: 'shop.notAKey' }]);

    // a11y t('a11y.nope') — a11y binding, not an a11yCopy key.
    const f2 = censusOfSource("import { t } from '../a11yCopy';\nt('a11y.nope');");
    expect(
      checkUndefinedKeys(f2.calls, messageIds, a11yKeys),
      "a11y t('a11y.nope') must produce exactly one UNDEFINED-KEY",
    ).toEqual([{ kind: 'UNDEFINED-KEY', module: 'a11y', key: 'a11y.nope' }]);

    // i18nT('a11y.world.region') — the key EXISTS, but only in a11yCopy, and this call is the
    // i18n binding — proves per-binding checking, not "known anywhere across both catalogs".
    const f3 = censusOfSource(
      "import { t as i18nT } from './i18n/resolver';\ni18nT('a11y.world.region');",
    );
    expect(
      checkUndefinedKeys(f3.calls, messageIds, a11yKeys),
      "i18nT('a11y.world.region') must be UNDEFINED-KEY against the i18n set even though the " +
        'key is a real a11yCopy key',
    ).toEqual([{ kind: 'UNDEFINED-KEY', module: 'i18n', key: 'a11y.world.region' }]);

    // `${t('shop.notAKey')}` — R1: the call INSIDE the interpolation must be found and classified.
    // The fixture IS source text, not a template: the placeholder is spliced from two pieces so no
    // single literal carries a dollar-brace (biome noTemplateCurlyInString).
    const f4 = censusOfSource(
      `import { t } from './i18n/resolver';\nconst s = \`$` + `{t('shop.notAKey')}\`;`,
    );
    expect(
      f4.calls,
      'the call inside the dollar-brace interpolation must be found as a literal call',
    ).toEqual([{ module: 'i18n', orig: 't', kind: 'literal', literal: 'shop.notAKey' }]);
    expect(
      checkUndefinedKeys(f4.calls, messageIds, a11yKeys),
      'a call planted inside a template interpolation must still produce exactly one UNDEFINED-KEY',
    ).toEqual([{ kind: 'UNDEFINED-KEY', module: 'i18n', key: 'shop.notAKey' }]);

    // t?.('a11y.nope') — R2: the optional-call operator must be recognised as a call.
    const f5 = censusOfSource("import { t } from '../a11yCopy';\nt?.('a11y.nope');");
    expect(
      checkUndefinedKeys(f5.calls, messageIds, a11yKeys),
      "t?.('a11y.nope') must be recognised as a call and produce exactly one UNDEFINED-KEY",
    ).toEqual([{ kind: 'UNDEFINED-KEY', module: 'a11y', key: 'a11y.nope' }]);
  });

  it('m24s7 PARITY-04: I18N-28 — DEAD-KEY over the live tree; the exemption roster is exactly [chrome.helpHint]', () => {
    const messageIds = parseMessageIdUnion(readFileSync(MESSAGE_IDS_PATH, 'utf8'));
    const census = computeCensus();
    const requested = new Set<string>();
    for (const f of census) {
      for (const c of f.calls) {
        if (c.module === 'i18n' && c.kind === 'literal' && c.literal !== undefined) {
          requested.add(c.literal);
        }
      }
    }
    // WRONG IMPL KILLED: a hand-widened exemption roster ({'chrome.helpHint', 'shop.title', …})
    // would silently mask real DEAD-KEY findings — pin the roster EXACTLY.
    expect(DEAD_KEY_EXEMPT, 'the DEAD-KEY exemption roster must be exactly one entry').toEqual([
      'chrome.helpHint',
    ]);
    const findings = checkDeadKeys(messageIds, requested, DEAD_KEY_EXEMPT);
    expect(findings, `live-tree DEAD-KEY findings: ${JSON.stringify(findings)}`).toEqual([]);
  });

  it('m24s7 PARITY-04: fixtures — proof-of-teeth for DEAD-KEY and STALE-EXEMPTION', () => {
    const ids = ['a.one', 'a.two', 'chrome.helpHint'];

    // BAD: 'a.two' has zero requesters — kills a checker that only walks REQUESTED keys forward
    // (a set-difference the other direction) instead of walking the full MessageId roster.
    const dead = checkDeadKeys(ids, new Set(['a.one']), ['chrome.helpHint']);
    expect(dead, "'a.two' with zero call sites must produce exactly one DEAD-KEY").toEqual([
      { kind: 'DEAD-KEY', key: 'a.two' },
    ]);

    // BAD: 'legacy.old' dead — same shape, a distinct key name (ledger's named fixture).
    const legacyDead = checkDeadKeys(['legacy.old', 'a.one'], new Set(['a.one']), []);
    expect(
      legacyDead,
      "'legacy.old' with zero call sites must produce exactly one DEAD-KEY",
    ).toEqual([{ kind: 'DEAD-KEY', key: 'legacy.old' }]);

    // BAD: chrome.helpHint IS requested despite being the exemption — a real requester means the
    // exemption itself is now stale and must be flagged, not silently accepted.
    const stale = checkDeadKeys(ids, new Set(['a.one', 'a.two', 'chrome.helpHint']), [
      'chrome.helpHint',
    ]);
    expect(stale, 'a requested exempt key must produce exactly one STALE-EXEMPTION').toEqual([
      { kind: 'STALE-EXEMPTION', key: 'chrome.helpHint' },
    ]);

    // GOOD: every non-exempt key requested, the exempt key never requested — zero findings.
    expect(
      checkDeadKeys(ids, new Set(['a.one', 'a.two']), ['chrome.helpHint']),
      'full coverage plus an unrequested exemption must produce zero findings',
    ).toEqual([]);
  });

  it('m24s7 PLURAL-01: per-locale Intl.PluralRules category set matches the registry', () => {
    // WRONG IMPL KILLED: a table whose key set never widens to match the registry.
    expect(
      Object.keys(PLURAL_CATEGORIES).sort(),
      "the plural-category table's locale set must equal Object.keys(CATALOGS)",
    ).toEqual(Object.keys(CATALOGS as Record<string, unknown>).sort());

    for (const locale of Object.keys(PLURAL_CATEGORIES)) {
      const supported = Intl.PluralRules.supportedLocalesOf([locale]);
      expect(supported.length, `Intl must have plural data for '${locale}'`).toBeGreaterThan(0);
      const actual = Array.from(
        new Intl.PluralRules(locale).resolvedOptions().pluralCategories,
      ).sort();
      const expected = [...PLURAL_CATEGORIES[locale]].sort();
      expect(actual, `'${locale}' plural categories`).toEqual(expected);
    }
  });

  describe('catalogFr (the fr runtime proof — CATALOGS.fr, S7)', () => {
    it("m24s7/21r-b FR-01: every fr closure reads exactly en's param fields, interpolates each, and >=100/178 values differ from en", () => {
      const en = CATALOG_EN as Record<string, unknown>;
      const fr = CATALOGS.fr as unknown as Record<string, unknown> | undefined;
      // WRONG IMPL KILLED: CATALOGS.fr undefined (unregistered / missing catalog.fr.ts).
      // A plain property read below would throw with a less legible message; this assertion
      // fails cleanly instead.
      expect(
        fr,
        'CATALOGS.fr must be defined once S7 ships catalog.fr.ts and registers it',
      ).not.toBe(undefined);
      const safeFr = fr as Record<string, unknown>;
      expect(Object.isFrozen(safeFr), 'CATALOG_FR must be Object.freeze()d').toBe(true);

      let differCount = 0;
      let checked = 0;
      // ASSUMPTION (R7, stated per plan §8): every en closure today is BRANCH-FREE — one
      // unconditional template literal per key. FR-02 below is the real backstop for the one
      // plural key this slice adds (battle.weather.banner), where that assumption does not hold.
      for (const key of Object.keys(en)) {
        checked += 1;
        const enValue = en[key];
        const frValue = safeFr[key];
        if (typeof enValue === 'function') {
          expect(typeof frValue, `'${key}' must be a closure in fr too (en is one)`).toBe(
            'function',
          );
          const enFn = enValue as (p: unknown) => string;
          const frFn = frValue as (p: unknown) => string;
          if (PLURAL_PARAM_KEYS.has(key)) {
            // Concrete params (real number for `turns`), not a sentinel proxy — see the
            // PLURAL_PARAM_KEYS comment above. FR-02 is the deep proof for this key; here we only
            // need a crash-free string output to fold into the >=100/112 differ tally.
            const sampleParams = { label: 'Sample', turns: 3 };
            const outputEn = enFn(sampleParams as never);
            const outputFr = frFn(sampleParams as never);
            expect(typeof outputFr, `'${key}' must return a string`).toBe('string');
            if (outputEn !== outputFr) differCount += 1;
            continue;
          }
          let lastEnOutput = '';
          let lastFrOutput = '';
          for (const family of ['SENTINEL_A', 'SENTINEL_B']) {
            const accessedEn = new Set<string>();
            const outputEn = enFn(makeFieldTrackingProxy(family, accessedEn));
            expect(
              accessedEn.size,
              `'${key}' en closure must read >=1 param field`,
            ).toBeGreaterThan(0);
            const accessedFr = new Set<string>();
            const outputFr = frFn(makeFieldTrackingProxy(family, accessedFr));
            expect(
              setsEqual(accessedEn, accessedFr),
              `'${key}' fr closure must read EXACTLY en's param field set (en: ` +
                `${Array.from(accessedEn).sort().join(',')}; fr: ${Array.from(accessedFr).sort().join(',')})` +
                ` under sentinel family '${family}' — this kills a closure that drops or adds a field`,
            ).toBe(true);
            for (const field of accessedEn) {
              expect(
                outputFr.includes(`${family}::${field}`),
                `'${key}' fr closure accessed '${field}' but never interpolated it into its ` +
                  `output — this kills a closure that reads a field only to discard it`,
              ).toBe(true);
            }
            lastEnOutput = outputEn;
            lastFrOutput = outputFr;
          }
          if (lastEnOutput !== lastFrOutput) differCount += 1;
        } else {
          expect(typeof frValue, `'${key}' must be a plain string in fr too (en is one)`).toBe(
            'string',
          );
          if (frValue !== enValue) differCount += 1;
        }
      }
      expect(
        checked,
        // 21r-b grew the roster from 118 to 133 keys and 21r-b2 grows it to 178 — the threshold
        // below (>=100) is intentionally UNCHANGED: it is a lower bound that only gets easier to
        // clear as the roster grows, never weakened.
        'anti-vacuity: the full 178-entry en catalog must have been walked',
      ).toBeGreaterThan(100);
      expect(
        differCount,
        `only ${differCount}/${checked} fr values differ from en — at least 100 of ${checked} must differ`,
      ).toBeGreaterThanOrEqual(100);
    });

    it('m24s7 FR-02: battle.weather.banner selects French plural forms (0≡1, 1≠2, 1e6 -> many)', () => {
      // The plural FORM is everything after the LAST DIGIT of the interpolated turn count, up to
      // (but excluding) the closing `)` — never just the last space-delimited word: CLDR-correct
      // French spells `many` as the TWO-WORD "de tours" ("1 000 000 de tours"), so a last-word
      // extractor collapses `many` and `other` (both end in the bare word "tours") and the
      // many-vs-other assertion below becomes unsatisfiable under correct French.
      function pluralForm(s: string): string {
        const trimmed = endsWith(s, ')') ? s.slice(0, -1) : s;
        let lastDigitIdx = -1;
        for (let i = 0; i < trimmed.length; i++) {
          const code = trimmed.charCodeAt(i);
          if (code >= 48 && code <= 57) lastDigitIdx = i;
        }
        const after = lastDigitIdx === -1 ? trimmed : trimmed.slice(lastDigitIdx + 1);
        let start = 0;
        while (start < after.length && isWhitespace(after.charAt(start))) start += 1;
        return after.slice(start);
      }
      try {
        setLocale('fr');
        const out0 = tf('battle.weather.banner', { label: 'Pluie', turns: 0 });
        const out1 = tf('battle.weather.banner', { label: 'Pluie', turns: 1 });
        const out2 = tf('battle.weather.banner', { label: 'Pluie', turns: 2 });
        const outMany = tf('battle.weather.banner', { label: 'Pluie', turns: 1_000_000 });
        expect(
          pluralForm(out0),
          "fr's 'one' category covers BOTH 0 and 1 — the two forms must match",
        ).toBe(pluralForm(out1));
        expect(pluralForm(out1), "fr's 'one' (1) and 'other' (2) forms must differ").not.toBe(
          pluralForm(out2),
        );
        expect(
          pluralForm(outMany),
          "fr's 'many' (1e6, «de tours») and 'other' (2, «tours») forms must differ — a " +
            'cldr({..., many: other}) authoring would collapse this',
        ).not.toBe(pluralForm(out2));
      } finally {
        setLocale('en');
      }
    });

    it("m24s7 FR-03: box.hint quotes its own locale's box.card.toParty; setLocale(fr) redirects t()", () => {
      try {
        setLocale('fr');
        expect(currentLocale(), 'currentLocale() must reflect the switch').toBe('fr');
        const fr = CATALOGS.fr as unknown as Record<string, unknown>;
        const boxHint = fr['box.hint'] as string;
        const toParty = fr['box.card.toParty'] as string;
        expect(
          boxHint.indexOf(toParty) !== -1,
          "fr's box.hint must quote fr's OWN box.card.toParty verbatim, never the English string",
        ).toBe(true);
        expect(
          t('chrome.help.title' as never),
          't() must read CATALOGS.fr once the locale is switched — a resolver that caches the ' +
            'first-read catalog would still return the en value here',
        ).toBe(fr['chrome.help.title']);
      } finally {
        setLocale('en');
      }
    });

    it('21r-b FR-04: every one of the 15 new keys has a CATALOG_FR value strictly different from CATALOG_EN (kills an untranslated copy-through, red-team S3)', () => {
      // The aggregate FR-01 tally (>=100/133 differ) can pass even while ONE specific key was
      // copy-pasted from en into fr — this test names each of the 15 new keys individually so a
      // single untranslated copy-through (e.g. 'trade.feedback.completed': 'Trade complete!'
      // left unchanged in catalog.fr.ts) fails BY NAME, not just a lowered aggregate count.
      const NEW_KEYS_21R_B: readonly string[] = [
        'chrome.feedback.disconnected',
        'chrome.rename.updated',
        'chrome.session.expired.title',
        'chrome.session.expired.body',
        'chrome.session.unreachable.title',
        'chrome.session.unreachable.body',
        'chrome.session.continue',
        'chrome.session.confirmPrompt',
        'shop.feedback.purchased',
        'shop.feedback.sold',
        'trade.feedback.accepted',
        'trade.feedback.rejected',
        'trade.feedback.completed',
        'trade.feedback.cancelled',
        'tradePropose.feedback.sent',
      ];
      expect(NEW_KEYS_21R_B.length, 'ANTI-VACUITY: the 21r-b plan names exactly 15 new keys').toBe(
        15,
      );

      const en = CATALOG_EN as Record<string, unknown>;
      const fr = CATALOGS.fr as unknown as Record<string, unknown> | undefined;
      expect(fr, 'CATALOGS.fr must be defined').not.toBe(undefined);
      const safeFr = fr as Record<string, unknown>;

      let checked = 0;
      for (const key of NEW_KEYS_21R_B) {
        expect(typeof en[key], `${key} must be a plain string in en`).toBe('string');
        expect(typeof safeFr[key], `${key} must be a plain string in fr`).toBe('string');
        expect(
          safeFr[key],
          `${key}: fr must differ from en — an untranslated copy-through (e.g. leaving ` +
            `'${key}' as the English bytes in catalog.fr.ts) must fail HERE, by name`,
        ).not.toBe(en[key]);
        checked += 1;
      }
      expect(checked, 'ANTI-VACUITY: all 15 keys must have been checked').toBe(15);
    });

    // -------------------------------------------------------------------------------------------
    // 21r-b2 — the 45 claim.* / privacy.* keys (claimModel.ts + privacyBanner.ts). Key lists are
    // hand-transcribed from memory/projects/monster-realm-21r-b2-plan.md's roster table.
    // -------------------------------------------------------------------------------------------

    /** U+00A0 NO-BREAK SPACE and U+2019 RIGHT SINGLE QUOTATION MARK, built from their code points
     *  so neither can be pasted as (or mistaken for) a plain space / an ASCII apostrophe. */
    const NBSP = String.fromCharCode(0x00a0);
    const RSQUO = String.fromCharCode(0x2019);

    /** The 38 plain keys 21r-b2 adds. */
    const NEW_PLAIN_KEYS_21R_B2: readonly string[] = [
      'claim.feedback.veto',
      'claim.nudge',
      'claim.decline.confirmPrompt',
      'claim.pending.title',
      'claim.pending.body',
      'claim.awaiting.title',
      'claim.awaiting.body',
      'claim.claimed.title',
      'claim.claimed.body',
      'claim.signInFailed.title',
      'claim.signInFailed.rejected',
      'claim.signInFailed.expired',
      'claim.signInFailed.declined',
      'claim.signInFailed.unreachable',
      'claim.signInFailed.fallback',
      'claim.reject.unusable.title',
      'claim.reject.unusable.body',
      'claim.reject.destination.title',
      'claim.reject.destination.body',
      'claim.reject.transient.title',
      'claim.reject.transient.body',
      'claim.reject.generic.title',
      'claim.reject.generic.body',
      'privacy.countdown.dark',
      'privacy.countdown.due',
      'privacy.notice.terminal',
      'privacy.notice.disconnected',
      'privacy.status.active',
      'privacy.status.unknown',
      'privacy.status.terminal',
      'privacy.export.none',
      'privacy.export.incompleteDark',
      'privacy.export.inconsistent',
      'privacy.action.delete',
      'privacy.confirm.prompt',
      'privacy.action.cancel',
      'privacy.action.export',
      'privacy.action.download',
    ];

    /** The 7 parameterised keys 21r-b2 adds, each with ONE concrete sample (no punctuation, so the
     *  typography sweep below judges only the catalog's own text). */
    const NEW_PARAM_SAMPLES_21R_B2: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['privacy.countdown.grace', { duration: 'SAMPLE' }],
      ['privacy.countdown.days', { n: 7n }],
      ['privacy.countdown.hours', { n: 7n }],
      ['privacy.countdown.minutes', { n: 7n }],
      ['privacy.countdown.seconds', { n: 7n }],
      ['privacy.export.incomplete', { received: 2, total: 5 }],
      ['privacy.export.complete', { received: 5 }],
    ];

    /** [key, fr text, en text] for all 45 keys — each value asserted to be the right KIND (plain
     *  string / closure) in BOTH catalogs first, so no comparison below runs on `undefined`. */
    function newKeyTexts21rB2(): Array<readonly [string, string, string]> {
      const en = CATALOG_EN as Record<string, unknown>;
      const fr = CATALOGS.fr as unknown as Record<string, unknown> | undefined;
      expect(fr, 'CATALOGS.fr must be defined').not.toBe(undefined);
      const safeFr = fr as Record<string, unknown>;
      const out: Array<readonly [string, string, string]> = [];
      for (const key of NEW_PLAIN_KEYS_21R_B2) {
        expect(typeof en[key], `${key} must be a plain string in en`).toBe('string');
        expect(typeof safeFr[key], `${key} must be a plain string in fr`).toBe('string');
        out.push([key, safeFr[key] as string, en[key] as string]);
      }
      for (const [key, sample] of NEW_PARAM_SAMPLES_21R_B2) {
        expect(typeof en[key], `${key} must be a closure in en`).toBe('function');
        expect(typeof safeFr[key], `${key} must be a closure in fr`).toBe('function');
        const enText = (en[key] as (p: Record<string, unknown>) => string)(sample);
        const frText = (safeFr[key] as (p: Record<string, unknown>) => string)(sample);
        expect(typeof frText, `${key}(sample) must return a string in fr`).toBe('string');
        out.push([key, frText, enText]);
      }
      return out;
    }

    it('[21R-B2-FR-DIFFERS] every one of the 45 new claim.* / privacy.* keys has a CATALOG_FR value strictly different from CATALOG_EN (parameterised keys compared through one concrete sample)', () => {
      // The aggregate FR-01 tally can pass while ONE of these keys was copied through from en —
      // this names each key, so an untranslated line fails BY NAME.
      // WRONG IMPL KILLED ★: e.g. 'privacy.status.terminal': 'This account has been permanently
      //   deleted.' left English in catalog.fr.ts, or a fr unit closure left as `${p.n}s`.
      const allKeys = [...NEW_PLAIN_KEYS_21R_B2, ...NEW_PARAM_SAMPLES_21R_B2.map(([key]) => key)];
      expect(allKeys.length, 'ANTI-VACUITY: the 21r-b2 plan names exactly 45 new keys').toBe(45);
      expect(new Set(allKeys).size, 'ANTI-VACUITY: no key may be listed twice').toBe(45);

      let checked = 0;
      for (const [key, frText, enText] of newKeyTexts21rB2()) {
        expect(
          frText,
          `${key}: fr must differ from en — an untranslated copy-through of the English bytes ` +
            'in catalog.fr.ts must fail HERE, by name',
        ).not.toBe(enText);
        checked += 1;
      }
      expect(checked, 'ANTI-VACUITY: all 45 keys must have been checked').toBe(45);
    });

    it('21r-b2 FR-TYPO: every new fr value puts U+00A0 before each ? ! : ; and uses no ASCII apostrophe', () => {
      // catalog.fr.ts's own convention (its header): a REAL no-break space before `:` `;` `!` `?`
      // and `’` U+2019 for the apostrophe.
      // WRONG IMPL KILLED (1) ★: "Confirmer la suppression ?" typed with an ordinary space — the
      //   browser may wrap the "?" of an irreversible-deletion prompt onto a line of its own.
      // WRONG IMPL KILLED (2): an ASCII apostrophe ("d'invité") — off-convention, and it would
      //   also close the single-quoted value in the catalog source.
      let marks = 0;
      let checked = 0;
      for (const [key, frText] of newKeyTexts21rB2()) {
        for (let i = 0; i < frText.length; i++) {
          const ch = frText.charAt(i);
          if (ch !== '?' && ch !== '!' && ch !== ':' && ch !== ';') continue;
          marks += 1;
          const before = i > 0 ? frText.charAt(i - 1) : '';
          expect(
            before === NBSP,
            `${key}: ${JSON.stringify(frText)} has "${ch}" at index ${i} preceded by ` +
              `${before === '' ? 'nothing' : `code point ${before.charCodeAt(0)}`}, not U+00A0`,
          ).toBe(true);
        }
        expect(
          frText.indexOf("'"),
          `${key}: ${JSON.stringify(frText)} uses an ASCII apostrophe — fr uses U+2019`,
        ).toBe(-1);
        checked += 1;
      }
      expect(checked, 'ANTI-VACUITY: all 45 keys must have been swept').toBe(45);
      expect(
        marks,
        'ANTI-VACUITY: both confirmation prompts end in a question mark, so the sweep must have ' +
          'judged at least two marks',
      ).toBeGreaterThanOrEqual(2);
    });

    it('21r-b2 FR-PINS: every new plain fr value carries its exact reviewed French bytes', () => {
      // FR-DIFFERS only proves each line is not English, and the model sweeps compare against
      // CATALOG_FR itself — so without these pins a placeholder or meaning-inverted French catalog
      // passes every other test. Every expectation is transcribed from the 21r-b2 plan's French
      // table, NEVER from catalog.fr.ts. The four destructive labels come first.
      // WRONG IMPL KILLED (1) ★: the delete and cancel labels swapped in catalog.fr.ts — a French
      //   player presses "Supprimer mon compte" believing it stops a deletion.
      // WRONG IMPL KILLED (2): a softened prompt that drops the irreversibility ("Confirmer ?", or
      //   a decline prompt that no longer says the code is deleted for good).
      // WRONG IMPL KILLED (3): a placeholder fr catalog ("FR: …", "TODO") that differs from en and
      //   satisfies every sweep that reads CATALOG_FR back.
      // WRONG IMPL KILLED (4): a meaning-inverted line (an active status that reads "supprimé", a
      //   claimed body that says the progress was lost) — fluent, non-English, and wrong.
      // WRONG IMPL KILLED (5): a parameterised closure that drops the U+00A0 unit spacing, swaps
      //   received / total, or re-adds a count-before-noun shape that needs a 0/1 singular.
      const fr = CATALOGS.fr as unknown as Record<string, unknown>;
      const PLAIN_PINS: ReadonlyArray<readonly [string, string]> = [
        // The four destructive / irreversible labels.
        ['privacy.action.delete', 'Supprimer mon compte'],
        ['privacy.action.cancel', 'Annuler la suppression du compte'],
        [
          'privacy.confirm.prompt',
          `Cette action est irréversible. Confirmer la suppression${NBSP}?`,
        ],
        [
          'claim.decline.confirmPrompt',
          `Refuser supprime définitivement ce code de transfert — votre progression d${RSQUO}invité ` +
            'ne pourra plus être récupérée une fois le code disparu. Refuser et continuer en tant ' +
            `qu${RSQUO}invité${NBSP}?`,
        ],
        // The rest of the claim overlay.
        [
          'claim.feedback.veto',
          'Terminez ou refusez le transfert en attente avant de rejoindre la partie.',
        ],
        [
          'claim.nudge',
          `La progression d${RSQUO}invité ne se transfère que depuis l${RSQUO}appareil sur lequel ` +
            'vous la récupérez.',
        ],
        ['claim.pending.title', `Conservez votre progression d${RSQUO}invité`],
        [
          'claim.pending.body',
          `Connectez-vous pour récupérer la progression réalisée en tant qu${RSQUO}invité, ou ` +
            `refusez pour continuer à jouer en tant qu${RSQUO}invité sur cet appareil.`,
        ],
        ['claim.awaiting.title', 'Finalisation du transfert'],
        [
          'claim.awaiting.body',
          'En attente que votre compte soit prêt avant que votre progression ' +
            `d${RSQUO}invité puisse être transférée.`,
        ],
        ['claim.claimed.title', 'Progression récupérée'],
        [
          'claim.claimed.body',
          `Votre progression d${RSQUO}invité est désormais rattachée à votre compte.`,
        ],
        ['claim.signInFailed.title', `La connexion n${RSQUO}a pas abouti`],
        [
          'claim.signInFailed.rejected',
          'La connexion a été refusée. Veuillez réessayer de vous connecter.',
        ],
        [
          'claim.signInFailed.expired',
          'Ce lien de connexion a expiré. Veuillez réessayer de vous connecter.',
        ],
        [
          'claim.signInFailed.declined',
          'La connexion a été annulée. Vous pourrez réessayer quand vous le souhaitez.',
        ],
        [
          'claim.signInFailed.unreachable',
          'Impossible de joindre le service de connexion. Veuillez réessayer dans un instant — ' +
            `votre progression d${RSQUO}invité est en sécurité.`,
        ],
        [
          'claim.signInFailed.fallback',
          `La connexion ne s${RSQUO}est pas terminée. Veuillez réessayer — votre progression ` +
            `d${RSQUO}invité est en sécurité.`,
        ],
        ['claim.reject.unusable.title', `Ce code de transfert n${RSQUO}est plus utilisable`],
        [
          'claim.reject.unusable.body',
          'Ce code de transfert a déjà été utilisé ou a expiré. Vous pouvez continuer à jouer sur ' +
            'cet appareil.',
        ],
        ['claim.reject.destination.title', 'Ce compte ne peut pas recevoir cette progression'],
        [
          'claim.reject.destination.body',
          'Ce compte possède déjà des données de jeu, la progression ' +
            `d${RSQUO}invité ne peut donc pas y être transférée. Le code de transfert reste ` +
            'valable sur un autre compte.',
        ],
        ['claim.reject.transient.title', 'Transfert pas encore possible'],
        [
          'claim.reject.transient.body',
          `Le transfert n${RSQUO}a pas pu aboutir pour le moment — fermez votre autre onglet ou ` +
            'terminez votre combat en cours, puis réessayez.',
        ],
        ['claim.reject.generic.title', 'Impossible de finaliser le transfert'],
        [
          'claim.reject.generic.body',
          'Vous devez vous connecter avant de pouvoir récupérer cette progression. Votre ' +
            `progression d${RSQUO}invité est en sécurité.`,
        ],
        // The rest of the privacy surface.
        ['privacy.countdown.dark', 'Suppression du compte en attente — temps restant indisponible'],
        ['privacy.countdown.due', 'Suppression du compte imminente'],
        [
          'privacy.notice.terminal',
          'Ce compte a déjà été définitivement supprimé. Il ne peut pas être restauré.',
        ],
        [
          'privacy.notice.disconnected',
          `Non connecté — votre demande n${RSQUO}a pas été envoyée. Réessayez.`,
        ],
        ['privacy.status.active', 'Ce compte est actif.'],
        ['privacy.status.unknown', 'Statut du compte indisponible.'],
        ['privacy.status.terminal', 'Ce compte a été définitivement supprimé.'],
        [
          'privacy.export.none',
          `Aucun export de données n${RSQUO}est encore arrivé sur cet appareil.`,
        ],
        [
          'privacy.export.incompleteDark',
          'Export de données incomplet — certains fragments manquent.',
        ],
        [
          'privacy.export.inconsistent',
          `L${RSQUO}export de données n${RSQUO}a pas pu être assemblé — les fragments livrés ne ` +
            'décrivent pas une seule demande. Demandez-le à nouveau.',
        ],
        ['privacy.action.export', `Demander l${RSQUO}export de mes données`],
        ['privacy.action.download', `Télécharger l${RSQUO}export de mes données`],
      ];
      /** The 7 closures, each through the ONE sample `NEW_PARAM_SAMPLES_21R_B2` already feeds the
       *  other 21r-b2 tests. */
      const PARAM_PINS: ReadonlyArray<readonly [string, string]> = [
        ['privacy.countdown.grace', 'Suppression du compte dans SAMPLE'],
        ['privacy.countdown.days', `7${NBSP}j`],
        ['privacy.countdown.hours', `7${NBSP}h`],
        ['privacy.countdown.minutes', `7${NBSP}min`],
        ['privacy.countdown.seconds', `7${NBSP}s`],
        [
          'privacy.export.incomplete',
          `Export de données incomplet — fragments livrés${NBSP}: 2 sur 5.`,
        ],
        ['privacy.export.complete', `Export de données prêt — fragments reçus${NBSP}: 5.`],
      ];

      // ANTI-VACUITY: the pins cover EXACTLY the 21r-b2 key lists above — none missing, none extra.
      expect(PLAIN_PINS.length, 'ANTI-VACUITY: all 38 new plain keys must be pinned').toBe(38);
      expect(
        PLAIN_PINS.map(([key]) => key).sort(),
        'the plain pins must cover exactly NEW_PLAIN_KEYS_21R_B2',
      ).toEqual([...NEW_PLAIN_KEYS_21R_B2].sort());
      expect(
        PARAM_PINS.map(([key]) => key).sort(),
        'the parameterised pins must cover exactly NEW_PARAM_SAMPLES_21R_B2',
      ).toEqual(NEW_PARAM_SAMPLES_21R_B2.map(([key]) => key).sort());

      let checked = 0;
      for (const [key, expected] of PLAIN_PINS) {
        expect(fr[key], `${key} must carry its exact reviewed French text`).toBe(expected);
        checked += 1;
      }
      const sampleOf = new Map(NEW_PARAM_SAMPLES_21R_B2);
      for (const [key, expected] of PARAM_PINS) {
        const closure = fr[key];
        expect(typeof closure, `${key} must be a closure in fr`).toBe('function');
        expect(
          (closure as (p: Record<string, unknown>) => string)(sampleOf.get(key) ?? {}),
          `${key}(sample) must render its exact reviewed French text`,
        ).toBe(expected);
        checked += 1;
      }
      expect(checked, 'ANTI-VACUITY: 38 plain + 7 parameterised pins must have run').toBe(45);
    });
  });
});
