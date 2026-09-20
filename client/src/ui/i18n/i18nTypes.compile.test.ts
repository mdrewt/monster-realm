// ui/i18n/i18nTypes.compile.test.ts — m24-s1 RED gating tests for the i18n module's
// compile-time totality guarantees (I18N-6..9) plus the compile-path control.
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M24-internationalization.spec.md §2.3, §6 S1 (I18N-6..9).
//   docs/adr/0256-i18n-module-total-catalog-resolver-cell-negative-compile.md D3 (BINDING).
//   memory/projects/monster-realm-m24-s1-plan.md §2, §3, §9 (fixture discipline amendments).
//
// RED REASON: `client/src/ui/i18n/{messageIds,resolver,plural,catalog.en}.ts` DO NOT EXIST YET.
// Every fixture that imports one of them fails to resolve, so every BAD fixture's diagnostic
// code SET comes back wrong (a TS2307 "cannot find module", never the pinned code), and every
// grouped assertion below reds for that reason until the specialist ships the five files.
//
// THE NEGATIVE COMPILE MECHANISM (ADR-0256 D3, extending ADR-0205 D6). `client/tsconfig.json`
// excludes `**/*.test.ts`, so nothing written in THIS file is ever typechecked by
// `just client-typecheck`, and `@ts-expect-error` is not this repo's house style (zero
// occurrences in `client/src`). Instead this file writes small probe `.ts` MODULES to a fresh
// temp dir and spawns `tsc --noEmit` on ALL of them in ONE invocation, then hand-parses the
// `name.ts(line,col): error TSnnnn` diagnostics with `indexOf`/`slice` (no RegExp) and asserts
// the EXACT error-code set per fixture.
//
// FIXTURE DISCIPLINE (plan §9, red-team-measured, mandatory):
//   (1) every fixture is a MODULE (has an import or an `export`) — a single spawn shares GLOBAL
//       scope across script-mode files, so a non-module fixture's bindings would collide with
//       every other fixture's bindings of the same name;
//   (2) every binding is `export`ed under a fixture-UNIQUE name;
//   (3) fixture bodies are '\n'-joined string arrays — no backticks/template literals in the
//       fixture TEXT itself;
//   (4) fixtures reach the real modules via ABSOLUTE, extension-less import specifiers
//       (`path.join(I18N_DIR, 'messageIds')` etc.) so they need no tsconfig of their own.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/ADR/plan
// only.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const I18N_DIR = path.dirname(fileURLToPath(import.meta.url));
/** `client/node_modules/.bin/tsc`, resolved explicitly (never PATH/npx) — a missing binary must
 *  RED every assertion below, never silently skip (ADR-0205 D6 precedent). */
const TSC_BIN = path.join(I18N_DIR, '..', '..', '..', 'node_modules', '.bin', 'tsc');

/** Absolute, extension-less specifiers: tsc resolves `.ts` on an absolute file specifier
 *  regardless of `moduleResolution`, so a probe written to an unrelated temp dir can import the
 *  real modules without its own tsconfig. */
const MESSAGE_IDS_SPEC = path.join(I18N_DIR, 'messageIds');
const CATALOG_EN_SPEC = path.join(I18N_DIR, 'catalog.en');
const RESOLVER_SPEC = path.join(I18N_DIR, 'resolver');
const PLURAL_SPEC = path.join(I18N_DIR, 'plural');
const LOCALE_SPEC = path.join(I18N_DIR, 'locale');

function importFrom(members: string, specifier: string): string {
  return `import ${members} from ${JSON.stringify(specifier)};`;
}

interface Fixture {
  readonly name: string;
  readonly lines: readonly string[];
}

const FIXTURES: readonly Fixture[] = [
  {
    // ANTI-VACUITY control: proves the spawn mechanism itself can produce a RED. Without this,
    // a broken spawn (wrong binary path, wrong cwd, mangled args) would make every "MUST NOT
    // COMPILE" assertion below pass for the wrong reason.
    name: 'control-red',
    lines: ["export const controlRed: number = 'nope';", ''],
  },
  {
    // Imports and USES every real export — zero diagnostics is the anti-vacuity half of every
    // BAD fixture below: if the totality/param/a11y/plural guarantees were simply absent (not
    // merely mistyped), this fixture would still need to compile clean.
    name: 'good',
    lines: [
      importFrom(
        'type { MessageId, ParamMessageId, PlainMessageId, MessageParams, Catalog, A11yKey }',
        MESSAGE_IDS_SPEC,
      ),
      importFrom('{ CATALOG_EN }', CATALOG_EN_SPEC),
      importFrom('{ t, tf, setLocale, currentLocale, CATALOGS, DEFAULT_LOCALE }', RESOLVER_SPEC),
      importFrom('{ selectPlural, fmtNumber, oneOther, cldr }', PLURAL_SPEC),
      importFrom('{ negotiateLocale, isRtl }', LOCALE_SPEC),
      '',
      'export const goodTotal: Catalog = CATALOG_EN;',
      "export const goodT: string = t('chrome.helpHint');",
      "export const goodTf: string = tf('chrome.status.disconnected', { where: 'x' });",
      "export const goodPlural: string = selectPlural('en', 1, oneOther('a', 'b'));",
      "export const goodCldr = cldr({ zero: 'z', one: 'o', two: 't', few: 'f', many: 'm', other: 'x' });",
      'export const goodSig: (key: PlainMessageId) => string = t;',
      "export const goodNeg: string = negotiateLocale(['fr-CA'], ['en', 'fr']);",
      "export const goodRtl: boolean = isRtl('ar');",
      'export const goodDefaultLocale: string = DEFAULT_LOCALE;',
      'export const goodCurrent: string = currentLocale();',
      'export const goodCatalogs: typeof CATALOGS = CATALOGS;',
      "setLocale('en');",
      "export const goodMessageId: MessageId = 'chrome.helpHint';",
      "export const goodParamMessageId: ParamMessageId = 'chrome.status.disconnected';",
      "export const goodParams: MessageParams['chrome.status.disconnected'] = { where: 'y' };",
      'export const goodA11yList: A11yKey[] = [];',
      "export const goodFmt: string = fmtNumber('en', 1);",
      '',
    ],
  },
  {
    // I18N-6 half 1: omitting a key from Catalog (via Omit) must not compile — TS2741, naming
    // the omitted key.
    name: 'bad-omit',
    lines: [
      importFrom('type { Catalog }', MESSAGE_IDS_SPEC),
      '',
      "declare const p: Omit<Catalog, 'chrome.helpHint'>;",
      'export const badOmit: Catalog = p;',
      '',
    ],
  },
  {
    // I18N-6 half 2: widening Catalog to Partial<Catalog> must not compile — TS2322.
    name: 'bad-partial',
    lines: [
      importFrom('type { Catalog }', MESSAGE_IDS_SPEC),
      '',
      'declare const q: Partial<Catalog>;',
      'export const badPartial: Catalog = q;',
      '',
    ],
  },
  {
    // I18N-6 half 3 (mutation red-team survivor fix): the READONLY layer of the totality
    // guarantee. Writing through a Catalog-typed parameter must not compile — TS2540 (cannot
    // assign to a read-only property). Kills a mutant that drops `readonly` from Catalog's
    // mapped type (a mutant the omit/partial fixtures above do NOT catch, since neither writes
    // through an already-typed Catalog value).
    name: 'bad-readonly',
    lines: [
      importFrom('type { Catalog }', MESSAGE_IDS_SPEC),
      '',
      'export function badReadonly(cat: Catalog): void {',
      "  cat['chrome.helpHint'] = 'x';",
      '}',
      '',
    ],
  },
  {
    // I18N-7 half 1: a missing required param property on tf() — TS2345 (a fresh object-literal
    // argument reports on the argument, per plan §9 M2/red-team H3).
    name: 'bad-params-missing',
    lines: [
      importFrom('{ tf }', RESOLVER_SPEC),
      '',
      "export const badParamsMissing: string = tf('chrome.status.disconnected', {});",
      '',
    ],
  },
  {
    // I18N-7 half 2: a PRESENT but mistyped param property — measured TS2322 (on the property
    // value), never TS2345.
    name: 'bad-params-type',
    lines: [
      importFrom('{ tf }', RESOLVER_SPEC),
      '',
      "export const badParamsType: string = tf('chrome.status.disconnected', { where: 42 });",
      '',
    ],
  },
  {
    // I18N-8 half 1: an a11y.* key handed to tf() — TS2345 (A11yKey is barred from tf's domain
    // by the type).
    // HONEST LIMIT: not yet load-bearing FOR THE A11Y-SPECIFIC EXCLUSION while A11yKey = never —
    // any string that is not a ParamMessageId produces the same TS2345 today, so this fixture
    // currently overlaps bad-plain-tf; it becomes load-bearing for the a11y case specifically the
    // moment a real a11y.* id joins MessageId (ADR-0256 D4 follow-up).
    name: 'bad-a11y-tf',
    lines: [
      importFrom('{ tf }', RESOLVER_SPEC),
      '',
      "export const badA11yTf: string = tf('a11y.overlay.boxView.title', {});",
      '',
    ],
  },
  {
    // I18N-8 half 2: a plain (non-parameterized) key handed to tf() — TS2345.
    name: 'bad-plain-tf',
    lines: [
      importFrom('{ tf }', RESOLVER_SPEC),
      '',
      "export const badPlainTf: string = tf('chrome.helpHint', {});",
      '',
    ],
  },
  {
    // I18N-8 half 3: a parameterized key handed to t() — TS2345 (t's domain excludes
    // ParamMessageId).
    name: 'bad-param-t',
    lines: [
      importFrom('{ t }', RESOLVER_SPEC),
      '',
      "export const badParamT: string = t('chrome.status.disconnected');",
      '',
    ],
  },
  {
    // I18N-9: a plural-forms object omitting a CLDR category reaching selectPlural() — TS2345
    // (PluralForms is total, never Partial).
    name: 'bad-plural',
    lines: [
      importFrom('{ selectPlural }', PLURAL_SPEC),
      '',
      "export const badPlural: string = selectPlural('ru', 3, { one: 'a', other: 'b' });",
      '',
    ],
  },
  {
    // SHAPE-05: t is pinned to `(key: A11yKey | PlainMessageId) => string`, i.e. today
    // `(key: PlainMessageId) => string` since A11yKey = never. Widening the parameter to `string`
    // must not compile — TS2322. This is the TRANSITIVE ORACLE for the "importing a11yCopy
    // widens A11yKey to string" hazard (ADR-0256 D4) — never delete this fixture as redundant.
    name: 'bad-t-wide',
    lines: [
      importFrom('{ t }', RESOLVER_SPEC),
      '',
      '// ADR-0256 D4 transitive oracle: importing a11yCopy widens A11yKey to string and would',
      '// make this assignment compile. Never delete this fixture as "redundant".',
      'export const badTWide: (key: string) => string = t;',
      '',
    ],
  },
];

interface CompileResult {
  readonly tscExists: boolean;
  readonly status: number | null;
  readonly output: string;
  readonly codesByFile: ReadonlyMap<string, readonly string[]>;
  readonly linesByFile: ReadonlyMap<string, readonly string[]>;
}

/** Hand-parses `<file>.ts(<line>,<col>): error TS<nnnn>: <message>` lines with
 *  `indexOf`/`slice` only — no `RegExp` (ADR-0256's own no-regex-in-modules convention, applied
 *  here to the tests too). Buckets by the exact path text tsc printed for the file — a bare
 *  basename for the fixtures (cwd = the temp dir, args passed as basenames) and an ABSOLUTE path
 *  for any diagnostic located inside a real, imported module. */
function parseDiagnostics(output: string): {
  codesByFile: Map<string, string[]>;
  linesByFile: Map<string, string[]>;
} {
  const codeSets = new Map<string, Set<string>>();
  const linesByFile = new Map<string, string[]>();
  const rawLines = output.split('\n');
  for (const line of rawLines) {
    const marker = '.ts(';
    const markerAt = line.indexOf(marker);
    if (markerAt === -1) continue;
    const filePart = line.slice(0, markerAt + 3);
    const rest = line.slice(markerAt + marker.length);
    const closeAt = rest.indexOf(')');
    if (closeAt === -1) continue;
    const tail = rest.slice(closeAt + 1);
    const errMarker = 'error TS';
    const errAt = tail.indexOf(errMarker);
    if (errAt === -1) continue;
    let digitsEnd = errAt + errMarker.length;
    while (digitsEnd < tail.length && tail[digitsEnd] >= '0' && tail[digitsEnd] <= '9') {
      digitsEnd += 1;
    }
    const code = `TS${tail.slice(errAt + errMarker.length, digitsEnd)}`;
    const set = codeSets.get(filePart) ?? new Set<string>();
    set.add(code);
    codeSets.set(filePart, set);
    const list = linesByFile.get(filePart) ?? [];
    list.push(line);
    linesByFile.set(filePart, list);
  }
  const codesByFile = new Map<string, string[]>();
  for (const [file, set] of codeSets) codesByFile.set(file, Array.from(set).sort());
  return { codesByFile, linesByFile };
}

function runCompileAll(): { result: CompileResult; dir: string | undefined } {
  const tscExists = existsSync(TSC_BIN);
  if (!tscExists) {
    return {
      result: {
        tscExists: false,
        status: null,
        output: '',
        codesByFile: new Map(),
        linesByFile: new Map(),
      },
      dir: undefined,
    };
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'm24s1-i18n-'));
  const fixtureFiles: string[] = [];
  for (const fixture of FIXTURES) {
    writeFileSync(path.join(dir, `${fixture.name}.ts`), fixture.lines.join('\n'), 'utf8');
    fixtureFiles.push(`${fixture.name}.ts`);
  }
  const spawned = spawnSync(
    TSC_BIN,
    [
      '--noEmit',
      '--strict',
      '--noUnusedLocals',
      '--noUnusedParameters',
      '--target',
      'ES2022',
      '--module',
      'ESNext',
      '--moduleResolution',
      'bundler',
      '--skipLibCheck',
      ...fixtureFiles,
    ],
    // A hung child is NOT bounded by the `it()` timeout (spawnSync blocks the event loop where
    // vitest's timer lives) — see overlayRegistry.test.ts's identical note. Real invocations
    // over ~13 small fixtures measure well under a second; 30s is generous headroom.
    { cwd: dir, encoding: 'utf8', timeout: 30000 },
  );
  const output = `${spawned.stdout ?? ''}${spawned.stderr ?? ''}`;
  const { codesByFile, linesByFile } = parseDiagnostics(output);
  return {
    result: { tscExists: true, status: spawned.status, output, codesByFile, linesByFile },
    dir,
  };
}

let cachedResult: CompileResult | undefined;
let cachedDir: string | undefined;

/** Memoised: the whole fixture set is written and compiled with ONE tsc invocation, shared by
 *  every `it()` below. */
function getResult(): CompileResult {
  if (!cachedResult) {
    const { result, dir } = runCompileAll();
    cachedResult = result;
    cachedDir = dir;
  }
  return cachedResult;
}

beforeAll(() => {
  getResult();
});

afterAll(() => {
  if (cachedDir) rmSync(cachedDir, { recursive: true, force: true });
});

/** Any diagnostic located INSIDE a real, imported module (path contains `/i18n/`) means the
 *  IMPLEMENTATION is buggy, not the fixture under test. Any diagnostic on `good.ts` means the
 *  "imports and uses every export" fixture itself failed to compile clean. Both are asserted
 *  absent in every grouped test below, each carrying the FULL tsc output for diagnosis.
 *
 *  Why `file.includes('/i18n/')` can never false-positive on the temp dir itself: `mkdtempSync`
 *  is seeded with the PREFIX `'m24s1-i18n-'` (hyphens, not slashes), so the generated directory
 *  name is something like `m24s1-i18n-Ab12Cd` — the substring around "i18n" there is `-i18n-`,
 *  never `/i18n/`. Fixture diagnostics are also printed as BARE basenames (`cwd` is the temp
 *  dir, and the spawned args are basenames), so a fixture's own path never contains a `/` at
 *  all; only a diagnostic actually resolved inside the real `client/src/ui/i18n/` module tree
 *  can contain the slash-delimited `/i18n/` segment this check looks for. */
function assertNoStrayDiagnostics(result: CompileResult): void {
  for (const [file, codes] of result.codesByFile) {
    if (codes.length === 0) continue;
    const isRealModule = file.includes('/i18n/');
    const isGoodFixture = file === 'good.ts';
    expect(
      isRealModule || isGoodFixture,
      `unexpected diagnostic(s) on ${file} (${codes.join(',')}) — a diagnostic inside the real i18n module, or on good.ts, means the fixture harness or the implementation is broken, never the fixture under test. Full tsc output:\n${result.output}`,
    ).toBe(false);
  }
}

function tscExistsMessage(): string {
  return `tsc binary must exist at ${TSC_BIN} — client/node_modules must be installed (just client-setup). A missing binary is an ANTI-VACUITY failure: every MUST-NOT-COMPILE assertion in this file would otherwise never actually invoke the compiler.`;
}

describe('i18nTypes.compile — the i18n module compile-total guarantees (m24-s1, ADR-0256)', () => {
  it('m24s1 I18N-6: omitting a catalog key (TS2741, naming the key), widening to Partial<Catalog> (TS2322), or writing through a Catalog-typed value (TS2540, the readonly layer) is a tsc RED; good.ts compiles clean', () => {
    const result = getResult();
    expect(result.tscExists, tscExistsMessage()).toBe(true);
    assertNoStrayDiagnostics(result);

    const omitCodes = result.codesByFile.get('bad-omit.ts') ?? [];
    expect(omitCodes, `full tsc output:\n${result.output}`).toEqual(['TS2741']);
    const omitLines = result.linesByFile.get('bad-omit.ts') ?? [];
    expect(
      omitLines.some((l) => l.includes('chrome.helpHint')),
      `bad-omit.ts's TS2741 message must name the omitted key 'chrome.helpHint':\n${omitLines.join('\n')}`,
    ).toBe(true);

    const partialCodes = result.codesByFile.get('bad-partial.ts') ?? [];
    expect(partialCodes, `full tsc output:\n${result.output}`).toEqual(['TS2322']);

    // The READONLY layer (mutation red-team survivor fix): writing through a Catalog-typed
    // parameter must not compile — TS2540, killing a `readonly` drop from Catalog's mapped type.
    const readonlyCodes = result.codesByFile.get('bad-readonly.ts') ?? [];
    expect(readonlyCodes, `full tsc output:\n${result.output}`).toEqual(['TS2540']);

    const goodCodes = result.codesByFile.get('good.ts') ?? [];
    expect(goodCodes, `good.ts must compile with zero diagnostics:\n${result.output}`).toEqual([]);
  });

  it('m24s1 I18N-7: a tf() params object missing a required key (TS2345) or carrying a mistyped one (TS2322, measured — not TS2345) is a tsc RED', () => {
    const result = getResult();
    expect(result.tscExists, tscExistsMessage()).toBe(true);
    assertNoStrayDiagnostics(result);

    const missingCodes = result.codesByFile.get('bad-params-missing.ts') ?? [];
    expect(missingCodes, `full tsc output:\n${result.output}`).toEqual(['TS2345']);

    const typeCodes = result.codesByFile.get('bad-params-type.ts') ?? [];
    expect(typeCodes, `full tsc output:\n${result.output}`).toEqual(['TS2322']);
  });

  it('m24s1 I18N-8: an a11y.* key reaching tf(), a plain key reaching tf(), a param key reaching t(), and t widened to (key: string) => string (the domain-widening oracle) are each a tsc RED', () => {
    const result = getResult();
    expect(result.tscExists, tscExistsMessage()).toBe(true);
    assertNoStrayDiagnostics(result);

    const a11yCodes = result.codesByFile.get('bad-a11y-tf.ts') ?? [];
    expect(a11yCodes, `full tsc output:\n${result.output}`).toEqual(['TS2345']);

    const plainCodes = result.codesByFile.get('bad-plain-tf.ts') ?? [];
    expect(plainCodes, `full tsc output:\n${result.output}`).toEqual(['TS2345']);

    const paramTCodes = result.codesByFile.get('bad-param-t.ts') ?? [];
    expect(paramTCodes, `full tsc output:\n${result.output}`).toEqual(['TS2345']);

    // bad-t-wide is the ADR-0256 D4 transitive oracle for the a11yCopy-import widening hazard —
    // asserted HERE (not just written and forgotten) because a widened `t` is exactly the shape
    // that would let an a11y.* key silently reach tf() undetected by the three checks above.
    const tWideCodes = result.codesByFile.get('bad-t-wide.ts') ?? [];
    expect(
      tWideCodes,
      `bad-t-wide.ts (widening t to (key: string) => string) must produce exactly TS2322 — full tsc output:\n${result.output}`,
    ).toEqual(['TS2322']);
  });

  it('m24s1 I18N-9: a plural-forms literal omitting a CLDR category reaching selectPlural() is a tsc RED (TS2345); good.ts (oneOther/cldr) compiles clean', () => {
    const result = getResult();
    expect(result.tscExists, tscExistsMessage()).toBe(true);
    assertNoStrayDiagnostics(result);

    const pluralCodes = result.codesByFile.get('bad-plural.ts') ?? [];
    expect(pluralCodes, `full tsc output:\n${result.output}`).toEqual(['TS2345']);

    const goodCodes = result.codesByFile.get('good.ts') ?? [];
    expect(
      goodCodes,
      `good.ts's oneOther/cldr lines must have compiled with zero diagnostics:\n${result.output}`,
    ).toEqual([]);
  });

  it('m24s1 COMPILE-CONTROL: the tsc spawn itself works — the always-red control fixture reds with TS2322, and the whole invocation exits non-zero with BAD fixtures present', () => {
    const result = getResult();
    expect(result.tscExists, tscExistsMessage()).toBe(true);
    assertNoStrayDiagnostics(result);

    const controlCodes = result.codesByFile.get('control-red.ts') ?? [];
    expect(
      controlCodes,
      `CONTROL fixture (assigning a string literal to \`number\`) must produce exactly TS2322 — if it does not, the tsc spawn itself is broken (path/cwd/args) and every MUST-NOT-COMPILE assertion elsewhere in this file is meaningless. Full tsc output:\n${result.output}`,
    ).toEqual(['TS2322']);

    expect(
      result.status,
      `BAD fixtures are present in this single invocation, so the whole tsc process must exit non-zero:\n${result.output}`,
    ).not.toBe(0);
  });
});
