// net/shellDocument.test.ts — the shell document's page global: reading it off a host object, and
// rendering the classic script a host serves as `/shell-config.js`.
//
// Every expected script is computed here from `JSON.stringify(doc)` with the three replacements
// (less-than, U+2028, U+2029 written as backslash-u escapes), and every rendered script is run on
// a fresh object and read back through `readShellDocument`, so the property proves both the exact
// bytes and that the bytes carry the same connection target.
//
// The non-ASCII characters are built from code points (named constants below), never typed.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { resolveConnectionConfig } from './connectionConfig';
import {
  readShellDocument,
  renderShellConfigScript,
  SHELL_CONFIG_GLOBAL,
  SHELL_CONFIG_SCRIPT,
  type ShellDocument,
  TARGET_KINDS,
  type TargetKind,
} from './shellDocument';

const BACKSLASH = String.fromCharCode(92);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const ESC_LT = `${BACKSLASH}u003c`;
const ESC_LS = `${BACKSLASH}u2028`;
const ESC_PS = `${BACKSLASH}u2029`;
const E_ACUTE = String.fromCharCode(0xe9);
const KANJI = String.fromCharCode(0x65e5) + String.fromCharCode(0x672c);
const DRAGON = String.fromCodePoint(0x1f409);
const NBSP = String.fromCharCode(0x00a0);

const PREFIX = 'globalThis.__MR_SHELL_CONFIG__=';

/** The script the contract names for `doc`, computed independently of the implementation. */
function expectedScript(doc: unknown): string {
  const json = JSON.stringify(doc)
    .split('<')
    .join(ESC_LT)
    .split(LS)
    .join(ESC_LS)
    .split(PS)
    .join(ESC_PS);
  return `${PREFIX}${json};`;
}

/** Run `script` as a classic script body whose `globalThis` is a fresh object; return the object. */
function runOnFreshGlobal(script: string): Record<string, unknown> {
  const fresh: Record<string, unknown> = {};
  new Function('globalThis', script)(fresh);
  return fresh;
}

/** True when the production resolver accepts `doc` (only the dev-default database differs). */
function prodAccepts(doc: ShellDocument): boolean {
  return doc.connection.db.trim().toLowerCase() !== 'monster-realm';
}

/** The full contract for one accepted document: exact bytes, no raw LT/LS/PS, and a read-back that
 *  resolves to the same target as the document itself in every build it is accepted in. */
function checkRoundTrip(doc: ShellDocument): void {
  const script = renderShellConfigScript(doc);
  expect(script).toBe(expectedScript(doc));
  expect(script.includes('<'), 'no less-than survives').toBe(false);
  expect(script.includes(LS), 'no raw U+2028 survives').toBe(false);
  expect(script.includes(PS), 'no raw U+2029 survives').toBe(false);

  const fresh = runOnFreshGlobal(script);
  expect(Object.keys(fresh), 'the script sets exactly the one global').toEqual([
    SHELL_CONFIG_GLOBAL,
  ]);
  const readBack = readShellDocument(fresh);
  expect(readBack).toEqual(doc);

  const devTarget = resolveConnectionConfig(doc, true);
  expect(resolveConnectionConfig(readBack, true)).toEqual(devTarget);
  expect(devTarget.uri, 'the resolved uri is the document`s, trimmed').toBe(
    doc.connection.uri.trim(),
  );
  expect(devTarget.db, 'the resolved db is the document`s, trimmed').toBe(doc.connection.db.trim());
  if (prodAccepts(doc)) {
    expect(resolveConnectionConfig(readBack, false)).toEqual(resolveConnectionConfig(doc, false));
  }
}

/** Path characters the resolver allows: no `?`, `#`, U+0000-U+0020 or U+007F. */
function pathSafe(raw: string): string {
  return [...raw]
    .filter((c) => {
      const n = c.codePointAt(0) ?? 0;
      return n > 0x20 && n !== 0x7f && c !== '?' && c !== '#';
    })
    .join('');
}

/** The strings the escaping exists for, each of which a path may hold. */
const HARD_STRINGS: readonly string[] = [
  '"',
  "'",
  BACKSLASH,
  '<',
  '</script>',
  '<!--',
  LS,
  PS,
  E_ACUTE,
  KANJI,
  DRAGON,
  NBSP,
  '@',
  '%',
  '>',
  '&',
];

const docOf = (uri: string, db: string, kind?: TargetKind): ShellDocument =>
  kind === undefined ? { connection: { uri, db } } : { connection: { uri, db, kind } };

const arbScheme = fc.constantFrom('ws', 'wss', 'WS', 'Wss');
const arbAuthority = fc.constantFrom(
  '127.0.0.1:3000',
  'play.example',
  'play.example:443',
  '[::1]:3000',
  'localhost:3000',
  'Play.Example',
);
const arbSegment = fc
  .array(
    fc.oneof(
      fc.constantFrom(...HARD_STRINGS),
      fc.string({ maxLength: 4 }),
      fc.string({ unit: 'binary', maxLength: 3 }),
    ),
    { maxLength: 5 },
  )
  .map((parts) => pathSafe(parts.join('')));
const arbPath = fc.option(
  arbSegment.map((s) => `/${s}${s === '' ? '' : '/'}`),
  { nil: '' },
);
const arbPad = fc.constantFrom('', ' ', '  ', '\t', '\n ');
const arbUri = fc
  .tuple(arbPad, arbScheme, arbAuthority, arbPath, arbPad)
  .map(([a, s, h, p, b]) => `${a}${s}://${h}${p}${b}`);
const arbDb = fc
  .tuple(
    arbPad,
    fc.oneof(
      fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/),
      fc.constantFrom('monster-realm', 'Monster-Realm', 'monster-realm-playtest'),
    ),
    arbPad,
  )
  .map(([a, d, b]) => `${a}${d}${b}`);
const arbKind = fc.option(fc.constantFrom(...TARGET_KINDS), { nil: undefined });
const arbDoc = fc.tuple(arbUri, arbDb, arbKind).map(([u, d, k]) => docOf(u, d, k));

describe('shell document constants', () => {
  it('names the page global, the served script and the four target kinds', () => {
    expect(SHELL_CONFIG_GLOBAL).toBe('__MR_SHELL_CONFIG__');
    expect(SHELL_CONFIG_SCRIPT).toBe('shell-config.js');
    expect([...TARGET_KINDS]).toEqual(['official', 'test', 'local', 'private']);
  });
});

describe('readShellDocument', () => {
  it('returns the host`s own value as is (the same reference)', () => {
    const value = { connection: { uri: 'ws://127.0.0.1:3000', db: 'realm-x' } };
    const host = { [SHELL_CONFIG_GLOBAL]: value };
    expect(readShellDocument(host)).toBe(value);
  });

  it('returns a non-document own value unchanged (it validates nothing)', () => {
    const arr = [1, 2];
    expect(readShellDocument({ [SHELL_CONFIG_GLOBAL]: arr })).toBe(arr);
    expect(readShellDocument({ [SHELL_CONFIG_GLOBAL]: null })).toBeNull();
    expect(readShellDocument({ [SHELL_CONFIG_GLOBAL]: 'text' })).toBe('text');
  });

  it('returns undefined when the host has no such property', () => {
    expect(readShellDocument({})).toBeUndefined();
    expect(readShellDocument(Object.create(null) as object)).toBeUndefined();
  });

  it('ignores an inherited property: only an own property is read', () => {
    const proto = { [SHELL_CONFIG_GLOBAL]: { connection: { uri: 'ws://h:1', db: 'inherited' } } };
    const host = Object.create(proto) as object;
    expect(readShellDocument(host)).toBeUndefined();
  });

  it('reads an own non-enumerable property, and reads it exactly once', () => {
    const value = { connection: { uri: 'ws://h:1', db: 'own' } };
    let reads = 0;
    const host = {};
    Object.defineProperty(host, SHELL_CONFIG_GLOBAL, {
      enumerable: false,
      get: () => {
        reads += 1;
        return value;
      },
    });
    expect(readShellDocument(host)).toBe(value);
    expect(reads).toBe(1);
  });

  it('lets an own accessor`s error propagate unchanged (the same error object)', () => {
    const boom = new Error('accessor refused');
    const host = {};
    Object.defineProperty(host, SHELL_CONFIG_GLOBAL, {
      get: () => {
        throw boom;
      },
    });
    let caught: unknown;
    try {
      readShellDocument(host);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
  });
});

describe('renderShellConfigScript', () => {
  it('writes the prefix, the JSON and a final semicolon for a plain document', () => {
    const doc = docOf('ws://127.0.0.1:3000', 'monster-realm-playtest', 'test');
    expect(renderShellConfigScript(doc)).toBe(
      'globalThis.__MR_SHELL_CONFIG__={"connection":{"uri":"ws://127.0.0.1:3000",' +
        '"db":"monster-realm-playtest","kind":"test"}};',
    );
  });

  it('escapes less-than, U+2028 and U+2029 and leaves every other character as JSON writes it', () => {
    const uri = `wss://play.example/a<b/${LS}${PS}"q'${BACKSLASH}${E_ACUTE}/`;
    const doc = docOf(uri, 'realm_1');
    const expected =
      `${PREFIX}{"connection":{"uri":"wss://play.example/a${ESC_LT}b/${ESC_LS}${ESC_PS}` +
      `${BACKSLASH}"q'${BACKSLASH}${BACKSLASH}${E_ACUTE}/","db":"realm_1"}};`;
    expect(renderShellConfigScript(doc)).toBe(expected);
  });

  it('validates nothing: a document the resolver refuses is rendered the same way', () => {
    const refused = docOf('http://not-a-socket/<x>', 'monster-realm');
    expect(renderShellConfigScript(refused)).toBe(expectedScript(refused));
    expect(() => resolveConnectionConfig(refused, false)).toThrow();
  });

  it.each(
    HARD_STRINGS.map((s) => [JSON.stringify(s), s] as const),
  )('round-trips a uri path holding %s', (_label, hard) => {
    for (const kind of [undefined, ...TARGET_KINDS]) {
      checkRoundTrip(docOf(`wss://play.example/stdb/${hard}/`, 'realm-hard', kind));
    }
  });

  it('round-trips a path holding every hard string at once, padded, with a dev-default db', () => {
    const path = `/${HARD_STRINGS.join('')}/`;
    checkRoundTrip(docOf(`  ws://127.0.0.1:3000${path} `, ' Monster-Realm ', 'local'));
    checkRoundTrip(docOf(`WSS://Play.Example${path}`, 'monster-realm-playtest'));
  });

  it('for every accepted document: exact script, no raw LT/LS/PS, and the read-back resolves to the same target', () => {
    fc.assert(
      fc.property(arbDoc, (doc) => {
        checkRoundTrip(doc);
      }),
      { numRuns: 300 },
    );
  });
});
