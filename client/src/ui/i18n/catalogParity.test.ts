// ui/i18n/catalogParity.test.ts — the §5.3 parity gate: PARITY-01..04 (I18N-26/27/28) + the
// per-locale plural-category shape + the `fr` runtime proof (m24-s7, ADR-0263).
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M24-internationalization.spec.md §5.3, §6 S7 [I18N-26/27/28].
//   docs/adr/0263 (pending) D3/D4/D5/D8; ADR-0262 D5 (chrome.helpHint DEAD-KEY exemption).
//   memory/projects/monster-realm-m24-s7-plan.md §2, §8 (review deltas R1-R8, BINDING).
//
// VEHICLE (ADR-0224/ADR-0257): the spec's own vocabulary implies a standalone
// `evals/i18n-catalog-parity.eval.mjs`; that vehicle is retired, so the invariant ships as this
// ordinary co-located vitest suite, same shape as `catalogShape.test.ts` (S6).
//
// RED REASON AT HEAD (m24-s7): `client/src/ui/i18n/catalog.fr.ts` DOES NOT EXIST YET and
// `resolver.ts`'s `CATALOGS` registry is still `{ en: CATALOG_EN }` — NO static import of
// `./catalog.fr` appears anywhere below (that would red the WHOLE file at collection instead of
// the five tests the plan predicts). The registry-equality pin (`['en', 'fr']`) and
// `CATALOGS.fr` reads below are what carry PARITY-01/PLURAL-01/FR-01/FR-02/FR-03 red until the
// specialist ships both files. PARITY-02/03/04 reason about the EXISTING S1-S6 tree and are
// GREEN on arrival (verified against the real `main.ts` + all 18 migrated view files).
//
// ZERO RegExp anywhere in this file (ADR-0055): every scan below is `String.indexOf` /
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
import { stripComments } from '../../../../evals/dom-shell-coverage-exclusion.eval.mjs';
import { a11yCopy } from '../a11yCopy';
import { CATALOG_EN } from './catalog.en';
// NO import of './catalog.fr' — see the header. `CATALOGS`, `t`, `tf`, `setLocale`,
// `currentLocale` are the resolver's public surface (ADR-0256 D1); `CATALOGS.fr` is read
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

    // WRONG IMPL KILLED: a registry that never widens past `{ en: CATALOG_EN }` — RED at HEAD.
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

  it('m24s7 PARITY-02: I18N-27 — import-binding resolution + the 19-file resolver roster + main.ts dual bindings', () => {
    const census = computeCensus();
    const i18nRoster = census
      .filter((f) => f.bindings.some((b) => b.module === 'i18n'))
      .map((f) => f.file)
      .sort();
    // WRONG IMPL KILLED: a bare global `t(`/`tf(` text scan (never resolving import specifiers)
    // would either miss every file (bindings always empty) or over-match unrelated `t(` calls
    // (e.g. `total(`) — the exact 19-file roster below is only reachable via real binding
    // resolution.
    expect(i18nRoster, `resolver-importing roster: ${JSON.stringify(i18nRoster)}`).toEqual([
      'main.ts',
      'ui/battleView.ts',
      'ui/boxView.ts',
      'ui/claimView.ts',
      'ui/dialogueView.ts',
      'ui/errorOverlayView.ts',
      'ui/evolutionNotice.ts',
      'ui/evolutionView.ts',
      'ui/healView.ts',
      'ui/helpView.ts',
      'ui/leaderboardView.ts',
      'ui/privacyView.ts',
      'ui/pvpView.ts',
      'ui/questLogView.ts',
      'ui/raisingView.ts',
      'ui/renameView.ts',
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
    expect(Array.from(i18nLiteralKeys).sort(), 'main.ts i18n-bound literal keys').toEqual([
      'chrome.status.bugBundleBlocked',
      'chrome.status.contentStale',
      'chrome.status.disconnected',
      'chrome.status.exportBlocked',
      'chrome.status.healUnavailable',
      'chrome.status.privacyOverlayBusy',
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
    // design (`OVERLAY_A11Y[id].labelKey`, ADR-0205) — a finding, never a skip: the roster below is
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
    // WRONG IMPL KILLED: a table whose key set never widens to match the registry — RED at HEAD
    // (registry is still ['en'] only).
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
    it("m24s7 FR-01: every fr closure reads exactly en's param fields, interpolates each, and >=100/112 values differ from en", () => {
      const en = CATALOG_EN as Record<string, unknown>;
      const fr = CATALOGS.fr as unknown as Record<string, unknown> | undefined;
      // WRONG IMPL KILLED: CATALOGS.fr undefined (unregistered / missing catalog.fr.ts) — RED at
      // HEAD. A plain property read below would throw with a less legible message; this assertion
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
        'anti-vacuity: the full 112-entry en catalog must have been walked',
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
  });
});
