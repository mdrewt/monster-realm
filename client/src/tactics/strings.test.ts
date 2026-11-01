// tactics/strings.test.ts — bt-10 RED tests for the tactical client's text discipline (BT10.6,
// REV 2 A6): every string the tactical UI shows comes from the typed catalog through
// `tactics/strings.ts` (the ONE resolver importer), in both English and French; and no other
// tactics module can smuggle in a hard-coded text sink, an HTML sink, a live region or a Web
// Animations call.
//
// SOURCE OF TRUTH: spec `### bt-10` BT10.6 ("every string from the typed catalog (en+fr)") and the
// plan's i18n key table + A4 (four status keys replace `tactics.ticker.status`) + A6 + A8
// (`tactics.banner.turn`) + A12 (no live region). The exact English bytes are pinned in
// ui/i18n/catalog.test.ts; THIS file pins the roster (60 keys), each key's parameter set, the French
// side, the `@desc` of each key, and the source scans.
//
// RED REASON: CATALOG_EN / CATALOG_FR carry no `tactics.*` key yet and strings.ts is an empty module,
// so the roster / French / strings.ts tests fail. The two scan tests are GUARDS (they pass over the
// stubs and bite the moment an implementation writes a forbidden sink); BT10-6-SCAN-TEETH proves each
// needle fires on a planted fixture.
//
// Do NOT edit these tests to match a buggy implementation; correct them from the spec only.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../test-util/stripComments';
import { CATALOG_EN } from '../ui/i18n/catalog.en';
import { CATALOG_FR } from '../ui/i18n/catalog.fr';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const I18N_DIR = path.resolve(HERE, '..', 'ui', 'i18n');
/** U+2014, by code point (never a pasted or escaped glyph). */
const EM_DASH = String.fromCharCode(0x2014);
/** A template-literal hole spelled without a dollar-brace in the test's own source text. */
const hole = (inner: string): string => `$${'{'}${inner}}`;

const EN = CATALOG_EN as unknown as Record<string, unknown>;
const FR = CATALOG_FR as unknown as Record<string, unknown>;

/** The 31 plain `tactics.*` keys. */
const PLAIN_KEYS: readonly string[] = [
  'tactics.board.label',
  'tactics.dock.label',
  'tactics.ticker.label',
  'tactics.turnbar.label',
  'tactics.turnbar.locked',
  'tactics.turnbar.surgeActive',
  'tactics.hud.guard',
  'tactics.hud.firstStand',
  'tactics.stance.aggressive',
  'tactics.stance.territorial',
  'tactics.stance.skittish',
  'tactics.status.poison',
  'tactics.status.burn',
  'tactics.status.paralysis',
  'tactics.status.sleep',
  'tactics.status.freeze',
  'tactics.intent.attack',
  'tactics.intent.move',
  'tactics.intent.hold',
  'tactics.halt.targetGone',
  'tactics.halt.outOfReach',
  'tactics.halt.cannotAct',
  'tactics.halt.itemNotHeld',
  'tactics.halt.unaffordable',
  'tactics.halt.partyFull',
  'tactics.halt.notAllowed',
  'tactics.ticker.battleStarted',
  'tactics.ticker.won',
  'tactics.ticker.lost',
  'tactics.ticker.fled',
  'tactics.ticker.battleEnded',
];

/** The 29 parameterised `tactics.*` keys and the exact fields each closure reads. */
const PARAM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'tactics.turnbar.round': ['round'],
  'tactics.turnbar.surgeIn': ['n'],
  'tactics.turnbar.retreatAt': ['round'],
  'tactics.hud.level': ['level'],
  'tactics.hud.hp': ['hp', 'max'],
  'tactics.hud.ap': ['ap', 'max'],
  'tactics.hud.role': ['role'],
  'tactics.ticker.executed': ['unit', 'skill'],
  'tactics.ticker.hit': ['target', 'damage'],
  'tactics.ticker.missed': ['unit', 'target'],
  'tactics.ticker.halted': ['unit', 'reason'],
  'tactics.ticker.voided': ['unit'],
  'tactics.ticker.autoPass': ['unit', 'strike'],
  'tactics.ticker.stoodGround': ['unit'],
  'tactics.ticker.statusApplied': ['unit', 'status'],
  'tactics.ticker.statusTick': ['unit', 'status', 'amount'],
  'tactics.ticker.statusCured': ['unit', 'status'],
  'tactics.ticker.statusBlocked': ['unit', 'status'],
  'tactics.ticker.surge': ['unit', 'amount'],
  'tactics.ticker.ko': ['unit'],
  'tactics.ticker.recruitOk': ['target'],
  'tactics.ticker.recruitFail': ['target', 'pct'],
  'tactics.ticker.awards': ['unit', 'xp', 'essence', 'currency'],
  'tactics.ticker.moved': ['unit', 'tiles'],
  'tactics.ticker.itemUsed': ['unit', 'item', 'target'],
  'tactics.ticker.turnEnded': ['unit'],
  'tactics.ticker.guarded': ['unit'],
  'tactics.ticker.roundEnded': ['round'],
  'tactics.banner.turn': ['unit'],
};

const PARAM_KEYS = Object.keys(PARAM_FIELDS);
const ROSTER = [...PLAIN_KEYS, ...PARAM_KEYS].sort();

const tacticsKeys = (catalog: Record<string, unknown>): string[] =>
  Object.keys(catalog)
    .filter((k) => k.startsWith('tactics.'))
    .sort();

/** Call a closure with a Proxy that records the fields it reads and hands back a sentinel for each. */
function probe(fn: (p: Record<string, unknown>) => string): { out: string; fields: string[] } {
  const accessed = new Set<string>();
  const proxy = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        accessed.add(prop);
        return `<<${prop}>>`;
      },
    },
  ) as Record<string, unknown>;
  const out = fn(proxy);
  return { out, fields: [...accessed].sort() };
}

describe('tactics strings: the catalog (BT10.6, A4, A8)', () => {
  it('BT10-6-STRINGS-ROSTER: both catalogs hold exactly the 60 tactics.* keys (31 plain, 29 parameterised), with the four status* keys instead of tactics.ticker.status, every key declared in messageIds.ts and every English entry carrying an adjacent @desc', () => {
    // WRONG IMPL KILLED: a key missing from one locale (t()/tf() throws in a French boot); the
    // dropped tactics.ticker.status left behind (A4); a parameterised key authored as a plain
    // string (or the reverse); a key in the catalog but not in the MessageId union / the
    // MessageParams table (the typed seam bypassed); an entry with no @desc (translators get no
    // context); a stray extra key nobody asked for.
    expect(PLAIN_KEYS, 'fixture: 31 plain keys').toHaveLength(31);
    expect(PARAM_KEYS, 'fixture: 29 parameterised keys').toHaveLength(29);
    expect(new Set(ROSTER).size, 'fixture: no key listed twice').toBe(60);

    expect(tacticsKeys(EN), 'the English catalog holds exactly the roster').toEqual(ROSTER);
    expect(tacticsKeys(FR), 'the French catalog holds exactly the roster').toEqual(ROSTER);
    expect(
      Object.hasOwn(EN, 'tactics.ticker.status'),
      'tactics.ticker.status was replaced (A4)',
    ).toBe(false);
    expect(Object.hasOwn(FR, 'tactics.ticker.status'), 'and in French').toBe(false);

    for (const key of PLAIN_KEYS) {
      expect(typeof EN[key], `en ${key} is a plain string`).toBe('string');
      expect(typeof FR[key], `fr ${key} is a plain string`).toBe('string');
      expect((EN[key] as string).length > 0, `en ${key} is not empty`).toBe(true);
    }
    for (const key of PARAM_KEYS) {
      expect(typeof EN[key], `en ${key} is a closure`).toBe('function');
      expect(typeof FR[key], `fr ${key} is a closure`).toBe('function');
    }

    const ids = stripComments(readFileSync(path.join(I18N_DIR, 'messageIds.ts'), 'utf8'));
    for (const key of ROSTER) {
      expect(ids.includes(`| '${key}'`), `${key} is in the MessageId union`).toBe(true);
    }
    for (const key of PARAM_KEYS) {
      expect(ids.includes(`readonly '${key}':`), `${key} is in the MessageParams table`).toBe(true);
    }
    for (const key of PLAIN_KEYS) {
      expect(ids.includes(`readonly '${key}':`), `${key} is plain: not in MessageParams`).toBe(
        false,
      );
    }

    const lines = readFileSync(path.join(I18N_DIR, 'catalog.en.ts'), 'utf8').split('\n');
    const missingDesc: string[] = [];
    for (const key of ROSTER) {
      const at = lines.findIndex((l) => l.trim().startsWith(`'${key}':`));
      if (at === -1) {
        missingDesc.push(`${key} (no entry line)`);
        continue;
      }
      let described = false;
      for (let j = at - 1; j >= 0; j--) {
        const c = lines[j].trim();
        if (!c.startsWith('//')) break;
        if (
          c.startsWith('// @desc:') &&
          c.slice('// @desc:'.length).replace(/\s/g, '').length >= 10
        ) {
          described = true;
        }
      }
      if (!described) missingDesc.push(key);
    }
    expect(
      missingDesc,
      'every tactics.* entry has an adjacent // @desc: of >= 10 characters',
    ).toEqual([]);
  });

  it('BT10-6-STRINGS-FR: for every tactics.* key the French differs from the English, and every closure reads exactly the same fields in both locales and prints each of them', () => {
    // WRONG IMPL KILLED: the English copied into catalog.fr.ts (a French boot reads English);
    // a French closure that drops a param (the damage, the unit, the amount) or reads a
    // different field name (the sentinel would not appear); an English closure that reads a field
    // the roster does not list (an undeclared param); a closure that ignores one of its params.
    for (const key of PLAIN_KEYS) {
      expect(FR[key], `${key}: French is not the English copy`).not.toBe(EN[key]);
    }
    for (const key of PARAM_KEYS) {
      const want = [...PARAM_FIELDS[key]].sort();
      const en = probe(EN[key] as (p: Record<string, unknown>) => string);
      const fr = probe(FR[key] as (p: Record<string, unknown>) => string);
      expect(en.fields, `${key}: the English closure reads exactly ${want.join(', ')}`).toEqual(
        want,
      );
      expect(fr.fields, `${key}: the French closure reads exactly ${want.join(', ')}`).toEqual(
        want,
      );
      for (const field of want) {
        expect(en.out.includes(`<<${field}>>`), `${key}: en prints {${field}}`).toBe(true);
        expect(fr.out.includes(`<<${field}>>`), `${key}: fr prints {${field}}`).toBe(true);
      }
      expect(fr.out, `${key}: French is not the English line`).not.toBe(en.out);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Source scans (A6)
// ---------------------------------------------------------------------------------------------

/** The text of every string literal in `expr` (a template literal contributes only the text
 *  outside its `${...}` holes). */
function literalTexts(expr: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "'" || ch === '"') {
      let text = '';
      i += 1;
      while (i < expr.length && expr[i] !== ch) {
        if (expr[i] === '\\') i += 1;
        text += expr[i] ?? '';
        i += 1;
      }
      out.push(text);
      i += 1;
    } else if (ch === '`') {
      let text = '';
      let depth = 0;
      i += 1;
      while (i < expr.length && !(expr[i] === '`' && depth === 0)) {
        if (expr[i] === '\\' && depth === 0) {
          i += 2;
          continue;
        }
        if (expr[i] === '$' && expr[i + 1] === '{') {
          depth += 1;
          i += 2;
          continue;
        }
        if (depth > 0 && expr[i] === '{') depth += 1;
        else if (depth > 0 && expr[i] === '}') depth -= 1;
        else if (depth === 0) text += expr[i];
        i += 1;
      }
      out.push(text);
      i += 1;
    } else {
      i += 1;
    }
  }
  return out;
}

const hasLetter = (s: string): boolean => /[A-Za-z]/.test(s);

/** Text of the balanced `( ... )` starting at the `(` at `open`, or '' when unbalanced. */
function balanced(src: string, open: number): string {
  let depth = 0;
  let quote = '';
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote !== '') {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return '';
}

/** The right-hand side of an assignment: from `from` to the first `;` or end of line outside
 *  quotes and brackets. */
function rhs(src: string, from: number): string {
  let depth = 0;
  let quote = '';
  let start = from;
  while (start < src.length && /\s/.test(src[start])) start += 1;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote !== '') {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if ((c === ';' || c === '\n') && depth <= 0) return src.slice(start, i);
  }
  return src.slice(start);
}

const SINK_PROPS = 'textContent|innerText|title|ariaLabel|alt|placeholder';
const SINK_ATTRS = [
  'aria-label',
  'title',
  'alt',
  'placeholder',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
];

/** Every forbidden construct in one non-strings tactics module, by rule id. */
function scanSource(raw: string): string[] {
  const src = stripComments(raw);
  const found = new Set<string>();
  if (/i18n\/resolver/.test(src)) found.add('resolver-import');
  if (/\b(innerHTML|outerHTML|insertAdjacentHTML)\b/.test(src)) found.add('html-sink');
  if (
    /aria-live|ariaLive|a11y-live|LIVE_REGION_ID/.test(src) ||
    /role\s*=\s*["'](status|log)["']/.test(src) ||
    /["']role["']\s*,\s*["'](status|log)["']/.test(src) ||
    /\.role\s*=\s*["'](status|log)["']/.test(src) ||
    /\brole\s*:\s*["'](status|log)["']/.test(src)
  ) {
    found.add('live-region');
  }
  if (/\.animate\s*\(/.test(src)) found.add('animate');

  const assign = new RegExp(`\\.(${SINK_PROPS})\\s*\\+?=(?!=)`, 'g');
  for (const m of src.matchAll(assign)) {
    const from = (m.index ?? 0) + m[0].length;
    if (literalTexts(rhs(src, from)).some(hasLetter)) found.add('text-literal');
  }
  for (const m of src.matchAll(/\.setAttribute\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const args = balanced(src, open);
    const [name, ...rest] = literalTexts(args);
    if (name !== undefined && SINK_ATTRS.includes(name) && rest.some(hasLetter)) {
      found.add('text-literal');
    }
  }
  for (const m of src.matchAll(/createTextNode\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    if (literalTexts(balanced(src, open)).some(hasLetter)) found.add('text-literal');
  }
  return [...found].sort();
}

/** What strings.ts does with the resolver: how it imports it and every t()/tf() call's first argument. */
function resolverUse(raw: string): {
  imported: boolean;
  aliased: boolean;
  calls: { fn: 't' | 'tf'; key: string | null }[];
} {
  const src = stripComments(raw);
  const imp = [
    ...src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g),
  ].filter((m) => /i18n\/resolver(\.ts|\.js)?$/.test(m[2]));
  const calls: { fn: 't' | 'tf'; key: string | null }[] = [];
  for (const m of src.matchAll(/(?<![.\w$])(tf|t)\s*(?:<[^>()]*>)?\s*\(\s*/g)) {
    const after = src.slice((m.index ?? 0) + m[0].length);
    const q = after[0];
    let key: string | null = null;
    if (q === "'" || q === '"') {
      const end = after.indexOf(q, 1);
      const next = after.slice(end + 1).trimStart()[0];
      if (end !== -1 && (next === ',' || next === ')')) key = after.slice(1, end);
    }
    calls.push({ fn: m[1] as 't' | 'tf', key });
  }
  return {
    imported: imp.length > 0,
    aliased: imp.some((m) => /\bas\b/.test(m[1])),
    calls,
  };
}

const TACTICS_FILES: string[] = readdirSync(HERE).filter(
  (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'strings.ts',
);

describe('tactics strings: the source scans (A6)', () => {
  it('BT10-6-SCAN-LIVE: no non-strings tactics module imports the resolver, writes an HTML sink, a live region or .animate(, or assigns a literal word to a text sink', () => {
    // WRONG IMPL KILLED: a second resolver importer (PARITY-02's roster is exact: one file); an
    // innerHTML / insertAdjacentHTML write (hostile species names are data); aria-live /
    // role=log|status (A11Y-05b keeps live regions in ui/liveRegion.ts); .animate() (the biome
    // no-waapi rule; reduced motion is CSS + the boolean); a hard-coded English label on
    // textContent / title / aria-label (the typed catalog is the only text source).
    for (const required of [
      'boardModel.ts',
      'boardRender.ts',
      'hud.ts',
      'turnBar.ts',
      'ticker.ts',
      'presentation.ts',
      'tacticsBattle.ts',
    ]) {
      expect(TACTICS_FILES, `${required} is among the scanned files`).toContain(required);
    }
    const bad: string[] = [];
    for (const file of TACTICS_FILES) {
      const findings = scanSource(readFileSync(path.join(HERE, file), 'utf8'));
      for (const f of findings) bad.push(`${file}: ${f}`);
    }
    expect(bad, 'forbidden constructs in the tactics modules').toEqual([]);
  });

  it('BT10-6-SCAN-TEETH: every needle fires on a planted fixture and stays quiet on clean code and on comments', () => {
    // WRONG IMPL KILLED (of the scan itself): a needle that never matches (the live scan above
    // would pass over a real violation); a needle that fires on a comment or on letter-free
    // assignments (the live scan would force contortions); a template literal text sink the
    // scanner reads as safe; a setAttribute sink the scanner misses.
    const cases: readonly (readonly [string, string, string])[] = [
      ['resolver-import', "import { t } from '../ui/i18n/resolver';", 'resolver-import'],
      ['html-sink: innerHTML', 'el.innerHTML = name;', 'html-sink'],
      ['html-sink: insertAdjacentHTML', "el.insertAdjacentHTML('beforeend', x);", 'html-sink'],
      ['html-sink: outerHTML', 'el.outerHTML = x;', 'html-sink'],
      ['live: aria-live', "el.setAttribute('aria-live', 'polite');", 'live-region'],
      ['live: role=log call', "el.setAttribute('role', 'log');", 'live-region'],
      ['live: role=status markup', 'const m = \'<div role="status"></div>\';', 'live-region'],
      ['live: .role', "el.role = 'status';", 'live-region'],
      ['live: object role', "const o = { role: 'log' };", 'live-region'],
      ['animate', 'el.animate([], { duration: 100 });', 'animate'],
      ['text: textContent literal', "el.textContent = 'Hello';", 'text-literal'],
      [
        'text: textContent literal on the next line',
        "el.textContent =\n  'Hello';",
        'text-literal',
      ],
      ['text: textContent template', `el.textContent = \`Lv ${hole('level')}\`;`, 'text-literal'],
      ['text: textContent ternary', "el.textContent = many ? 'many' : 'one';", 'text-literal'],
      ['text: textContent concat', "el.textContent += ' items';", 'text-literal'],
      ['text: title literal', "el.title = 'x y';", 'text-literal'],
      ['text: aria-label literal', "el.setAttribute('aria-label', 'Close');", 'text-literal'],
      [
        'text: title attribute template',
        `el.setAttribute("title", \`Open ${hole('name')}\`);`,
        'text-literal',
      ],
      ['text: createTextNode', "el.appendChild(document.createTextNode('Hi'));", 'text-literal'],
    ];
    for (const [label, source, rule] of cases) {
      expect(scanSource(source), `${label} fires ${rule}`).toContain(rule);
    }
    const clean = [
      "el.textContent = '';",
      `el.textContent = ' ${EM_DASH} ';`,
      `el.textContent = \`${hole('n')}\`;`,
      `el.textContent = \`${hole('pct / 10')}%\`;`,
      'el.textContent =\n  label(n);',
      'el.textContent = label(n);',
      "el.textContent = 12 + ' ' + 3;",
      "el.setAttribute('aria-label', strings.lock());",
      "el.setAttribute('data-unit-id', String(id));",
      "el.setAttribute('role', 'presentation');",
      "el.className = 'tactics-chip';",
      "el.classList.toggle('tactics--reduced', on);",
      "const t = (x: number) => x; t(1); // el.innerHTML = 'x'",
      "/* el.setAttribute('aria-live', 'polite'); el.animate() */ const a = 1;",
      "// import { t } from '../ui/i18n/resolver';",
    ];
    for (const source of clean) {
      expect(scanSource(source), `clean: ${source}`).toEqual([]);
    }
  });
});

describe('tactics strings: strings.ts (BT10.6, A6)', () => {
  it('BT10-6-STRINGS-RESOLVER: strings.ts imports t/tf from the resolver unaliased, every t()/tf() first argument is a string literal, plain keys go through t and parameterised keys through tf, and all 60 tactics.* keys are requested', () => {
    // WRONG IMPL KILLED: a dynamic key (`t(\`tactics.stance.${s}\`)` — PARITY-02's dynamic-key scan
    // refuses it, and a typo would only fail at runtime); an aliased import the scan cannot follow;
    // t() on a closure key or tf() on a plain key (the resolver throws); a catalog key nothing
    // requests (PARITY-04 DEAD-KEY); a key requested that the catalog does not define.
    const raw = readFileSync(path.join(HERE, 'strings.ts'), 'utf8');
    const use = resolverUse(raw);
    expect(use.imported, 'strings.ts imports from ui/i18n/resolver').toBe(true);
    expect(use.aliased, 'and does not alias t / tf').toBe(false);
    expect(use.calls.length > 0, 'strings.ts calls t / tf').toBe(true);
    expect(
      use.calls.filter((c) => c.key === null).map((c) => c.fn),
      'no dynamic-key call',
    ).toEqual([]);

    const requested = new Map<string, Set<'t' | 'tf'>>();
    for (const c of use.calls) {
      if (c.key === null) continue;
      const set = requested.get(c.key) ?? new Set<'t' | 'tf'>();
      set.add(c.fn);
      requested.set(c.key, set);
    }
    for (const key of PLAIN_KEYS) {
      expect(requested.get(key)?.has('t'), `${key} is requested through t()`).toBe(true);
      expect(requested.get(key)?.has('tf') ?? false, `${key} is not requested through tf()`).toBe(
        false,
      );
    }
    for (const key of PARAM_KEYS) {
      expect(requested.get(key)?.has('tf'), `${key} is requested through tf()`).toBe(true);
      expect(requested.get(key)?.has('t') ?? false, `${key} is not requested through t()`).toBe(
        false,
      );
    }
    for (const key of requested.keys()) {
      expect(Object.hasOwn(EN, key), `${key} (requested by strings.ts) exists in the catalog`).toBe(
        true,
      );
    }

    // Teeth for the extractor itself.
    const sample = [
      "import { t, tf } from '../ui/i18n/resolver';",
      "export const a = () => t('tactics.board.label');",
      "export const b = (n: number) => tf('tactics.turnbar.round', { round: n });",
      'export const c = (k: string) => t(k);',
      'export const d = (k: string) => t(`tactics.x.${k}`);',
      "export const e = () => obj.t('tactics.not.a.call');",
    ].join('\n');
    const probeUse = resolverUse(sample);
    expect(
      probeUse.calls.map((c) => [c.fn, c.key]),
      'literal keys read, dynamic keys flagged, member calls ignored',
    ).toEqual([
      ['t', 'tactics.board.label'],
      ['tf', 'tactics.turnbar.round'],
      ['t', null],
      ['t', null],
    ]);
    expect(
      resolverUse("import { t as tt } from '../ui/i18n/resolver';").aliased,
      'an alias is seen',
    ).toBe(true);
    expect(
      resolverUse("import { x } from './other';").imported,
      'another module is not the resolver',
    ).toBe(false);
  });
});
