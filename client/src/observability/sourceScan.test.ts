// observability/sourceScan.test.ts — m20c (ADR-0180 body amendment): T-16b, T-35a, T-A2.
//
// SOURCE OF TRUTH: EARS OBS-16 (no auth credential), OBS-34/35 (no player text / no identity),
// AM3 (the credential scan covers observability/*.ts AND the new main.ts hunks — the main.ts half
// lives in main.wiring.test.ts's m20c block), AM21 (node-env purity: no ambient host globals; no
// `new RegExp`).
//
// WHY A SOURCE SCAN AND NOT A UNIT TEST: the runtime teeth in telemetry.test.ts prove what the
// SHIPPED code paths do with the fake SDK injected. They cannot prove the ABSENCE of a second
// path — a header attached only when a token happens to exist, a `navigator` read behind a
// feature check, an identity interpolated into a URL on a branch no test drives. A whole-file
// ban is closed by construction; a behavioural test over a fake is not.
//
// THIS FILE HAS NO SIBLING MODULE ON PURPOSE: it scans the whole directory, so a NEW file added
// to client/src/observability/ later is covered automatically, with nobody having to remember.
//
// RED REASON: `client/src/observability/` contains no source modules yet — the walk below throws
// a NAMED error rather than skipping, so "the directory does not exist" is a hard red and can
// never be mistaken for "the scan found nothing wrong".
//
// NO `new RegExp(...)` IN THIS FILE EITHER (the repo-wide Semgrep ban): indexOf / includes /
// split / toLowerCase only.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const OBS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The eight modules the m20c plan specifies (§1 + AM2). Presence is asserted so that a scan
 *  which happens to find only one file cannot pass every ban vacuously. */
const REQUIRED_MODULES: readonly string[] = [
  'attributes.ts',
  'config.ts',
  'deviceClass.ts',
  'frameWindow.ts',
  'instruments.ts',
  'interpGap.ts',
  'names.ts',
  'telemetry.ts',
];

interface SourceFile {
  readonly name: string;
  /** RAW file text. Used by the SECURITY bans (T-16b credentials, T-35a identity), where a
   *  commented-out header or a prose mention is itself the hazard: a commented-out
   *  `// headers: { Authorization: token }` is one keystroke from being live. */
  readonly text: string;
  /** Lower-cased copy of the RAW text, so those scans are case-insensitive. */
  readonly folded: string;
  /** COMMENT-STRIPPED text. Used by the PURITY bans (no RegExp, no host globals, no ambient
   *  clock, no console, no static SDK import), where the rule is about what the code DOES and a
   *  module header that names the banned construct in order to explain the rule
   *  ("the caller passes performance.now()") must not red a correct implementation. */
  readonly code: string;
}

interface ScanResult {
  /** Source with every COMMENT removed. String/template literals are PRESERVED verbatim — they
   *  are code, and a needle inside one must still count. */
  readonly code: string;
  /** The CONTENT of every string/template literal encountered (delimiters excluded). */
  readonly literals: readonly string[];
}

/** A string-literal-aware comment scanner.
 *
 *  WHY NOT THE OBVIOUS `indexOf('/*')` LOOP (red-team X1, PROVEN live against the first draft of
 *  this file): a naive stripper treats the two characters `/` `*` inside a STRING LITERAL as the
 *  start of a block comment, finds no terminator, and silently drops the ENTIRE REST OF THE FILE.
 *  Everything after that point becomes invisible to every purity ban here — a live `console.log`
 *  measured GREEN. One innocuous-looking string literal disables the whole scan, and nothing says
 *  so. The self-test below plants exactly that shape and proves the ban still fires.
 *
 *  Modes: code / line-comment / block-comment / single / double / template, with backslash
 *  escapes honoured inside the three string modes. An unescaped newline inside a `'…'` or `"…"`
 *  literal ENDS it (JS forbids it there), which stops a stray apostrophe from swallowing the
 *  file — the same class of runaway, from the other direction.
 *
 *  KNOWN LIMIT, stated rather than hidden: `${…}` interpolation is not parsed, so a backtick
 *  inside an interpolation expression would confuse the template mode. No such construct exists
 *  in this tree, and the failure direction is a SHORTER `code` string, which reds a ban rather
 *  than passing one.
 *
 *  No `new RegExp` — banned repo-wide, in tests as much as in source. */
function scanSource(src: string): ScanResult {
  const CODE = 0;
  const LINE = 1;
  const BLOCK = 2;
  const SINGLE = 3;
  const DOUBLE = 4;
  const TEMPLATE = 5;

  let code = '';
  const literals: string[] = [];
  let literal = '';
  let mode = CODE;
  let i = 0;

  while (i < src.length) {
    const ch = src.charAt(i);
    const next = src.charAt(i + 1);

    if (mode === CODE) {
      if (ch === '/' && next === '/') {
        mode = LINE;
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        mode = BLOCK;
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        mode = ch === "'" ? SINGLE : ch === '"' ? DOUBLE : TEMPLATE;
        literal = '';
        code += ch;
        i += 1;
        continue;
      }
      code += ch;
      i += 1;
      continue;
    }

    if (mode === LINE) {
      if (ch === '\n') {
        code += ch;
        mode = CODE;
      }
      i += 1;
      continue;
    }

    if (mode === BLOCK) {
      if (ch === '*' && next === '/') {
        mode = CODE;
        i += 2;
        continue;
      }
      if (ch === '\n') code += ch; // keep the line structure the region slicers rely on
      i += 1;
      continue;
    }

    // --- inside a string literal: the text is CODE and is kept verbatim ---------------
    code += ch;
    if (ch === '\\') {
      code += next;
      literal += next;
      i += 2;
      continue;
    }
    const closer = mode === SINGLE ? "'" : mode === DOUBLE ? '"' : '`';
    if (ch === closer) {
      literals.push(literal);
      literal = '';
      mode = CODE;
      i += 1;
      continue;
    }
    if (ch === '\n' && mode !== TEMPLATE) {
      literals.push(literal); // unterminated '…' / "…": bail back to code, never run away
      literal = '';
      mode = CODE;
      i += 1;
      continue;
    }
    literal += ch;
    i += 1;
  }

  if (mode === SINGLE || mode === DOUBLE || mode === TEMPLATE) literals.push(literal);
  return { code, literals };
}

/** RECURSIVE walk for non-test `.ts` files, returning POSIX-style paths relative to `dir`.
 *
 *  WHY RECURSIVE (red-team X3, PROVEN live): the first draft used a flat `readdirSync`, so a
 *  module parked at `client/src/observability/internal/otlp.ts` was invisible to every ban in
 *  this file — including the credential and identity scans. One subdirectory disabled the whole
 *  control, and the required-module check still passed because the eight top-level files were
 *  all present. The self-test below plants a nested module in a temp directory and proves it is
 *  picked up. */
function collectTsFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(path.join(dir, entry.name), rel));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    out.push(rel);
  }
  return out.sort();
}

/** Read every non-test `.ts` file under client/src/observability, at ANY depth. Throws LOUD on a
 *  missing directory or an empty result — a vacuous zero is the failure mode this whole file
 *  exists to avoid, so it must never be reachable. */
function readObservabilitySources(): readonly SourceFile[] {
  let names: string[];
  try {
    names = collectTsFiles(OBS_DIR);
  } catch (err) {
    throw new Error(
      `client/src/observability could not be read at ${OBS_DIR} — ${String(err)}. The m20c ` +
        'source-scan teeth cannot run against a missing directory; this is a HARD RED, not a skip.',
    );
  }

  const sources = names.map((name) => {
    const text = readFileSync(path.join(OBS_DIR, name), 'utf8');
    return { name, text, folded: text.toLowerCase(), code: scanSource(text).code };
  });

  if (sources.length === 0) {
    throw new Error(
      `no non-test .ts modules found under ${OBS_DIR} — every ban below would pass vacuously. ` +
        'The implementation does not exist yet (expected first red), or the layout moved.',
    );
  }
  return sources;
}

/** SECURITY ban over RAW, case-folded source (comments included — see SourceFile.text).
 *  Every scan reports WHICH file and WHERE, so a red is actionable without a second run. */
function expectAbsent(sources: readonly SourceFile[], needle: string, why: string): void {
  const folded = needle.toLowerCase();
  for (const file of sources) {
    const at = file.folded.indexOf(folded);
    expect(
      at,
      `observability/${file.name} must not contain "${needle}" (found at offset ${at}). ${why}`,
    ).toBe(-1);
  }
}

/** PURITY ban over COMMENT-STRIPPED source, case-SENSITIVE (see SourceFile.code). Case matters
 *  here: `frameWindow.frames` contains "Window." and must not be mistaken for a `window.` global
 *  read. */
function expectAbsentInCode(sources: readonly SourceFile[], needle: string, why: string): void {
  for (const file of sources) {
    const at = file.code.indexOf(needle);
    expect(
      at,
      `observability/${file.name} must not contain the CODE \`${needle}\` (at offset ${at}). ` +
        `${why} (Comments are stripped before this scan, so explaining the rule in a comment is ` +
        'fine — writing the construct is not.)',
    ).toBe(-1);
  }
}

describe('sourceScan SELF-TESTS: the scanner and the walk are themselves gated', () => {
  // A source-scan tooth is only as good as its scanner. Both fixtures below encode a cheat that
  // was MEASURED GREEN against the first draft of this file — they exist so that a future
  // "simplification" of either helper reds here, loudly, instead of silently disabling every ban.

  it('X1 self-test: an unclosed `/*` inside a STRING LITERAL does not blind the scanner', () => {
    // THE PROVEN CHEAT: with the naive `indexOf('/*')` stripper, the first line below opened a
    // block comment that never closed, so everything after it — including the live console.log —
    // was deleted before any ban ran. Every purity assertion in this file passed on a file that
    // demonstrably violated them.
    const decoyOpen = ['/', '*'].join(''); // built, so this fixture cannot trip the file's own scan
    const fixture = [
      `const decoy = 'inline ${decoyOpen} not a comment';`,
      '// a real line comment mentioning console.log',
      `${decoyOpen} a real block comment mentioning console.log *${'/'}`,
      'console.log(1);',
    ].join('\n');

    const scanned = scanSource(fixture);

    expect(
      scanned.code.includes('console.log(1);'),
      'the LIVE statement after a string literal containing an unclosed block-comment opener ' +
        'must survive the strip — if it does not, every ban in this file is blind from that ' +
        'literal onward (red-team X1)',
    ).toBe(true);
    expect(
      scanned.code.includes('a real line comment'),
      'a genuine `//` comment must still be removed',
    ).toBe(false);
    expect(
      scanned.code.includes('a real block comment'),
      'a genuine block comment must still be removed',
    ).toBe(false);
    expect(
      scanned.code.split('console.log').length - 1,
      'exactly ONE console.log must survive: the live one. The two inside comments must not.',
    ).toBe(1);
    expect(
      scanned.literals.includes(`inline ${decoyOpen} not a comment`),
      'the literal collector must capture the string CONTENT (it is what the /* -in-a-literal ' +
        'ban in main.wiring.test.ts reads)',
    ).toBe(true);
  });

  it('X1 self-test: a stray apostrophe cannot swallow the rest of the file either', () => {
    // The mirror-image runaway: an unterminated `'…'` literal. JS forbids a raw newline inside
    // one, so the scanner ends the literal at the line break instead of treating everything after
    // it as string content (which would hide the next line's banned token just as effectively).
    const fixture = ["const s = 'unterminated", 'console.error(2);'].join('\n');
    expect(scanSource(fixture).code.includes('console.error(2);')).toBe(true);
  });

  it('X3 self-test: the walk is RECURSIVE — a module in a subdirectory cannot hide from the bans', () => {
    // THE PROVEN CHEAT: `client/src/observability/internal/otlp.ts` was invisible to the flat
    // `readdirSync` the first draft used, so a file there could carry an Authorization header, a
    // `navigator` read and an identity interpolation with every tooth in this file still green.
    // The fixture is planted in a TEMP directory and removed afterwards — client/src must never
    // acquire a stray non-test .ts file just to satisfy a test.
    const tmp = mkdtempSync(path.join(tmpdir(), 'mr-m20c-scan-'));
    try {
      mkdirSync(path.join(tmp, 'internal'), { recursive: true });
      writeFileSync(path.join(tmp, 'top.ts'), 'export const a = 1;\n');
      writeFileSync(path.join(tmp, 'internal', 'deep.ts'), 'export const b = 2;\n');
      writeFileSync(path.join(tmp, 'internal', 'deep.test.ts'), 'export const c = 3;\n');

      expect(
        collectTsFiles(tmp),
        'the walk must find nested modules (and must still skip *.test.ts at any depth)',
      ).toEqual(['internal/deep.ts', 'top.ts']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('observability/*.ts (structure): the module set the scans below depend on', () => {
  it('all eight m20c modules exist — anti-vacuity for every ban in this file', () => {
    const names = readObservabilitySources().map((f) => f.name);
    for (const required of REQUIRED_MODULES) {
      expect(
        names.includes(required),
        `client/src/observability/${required} is missing. Found: ${JSON.stringify(names)}`,
      ).toBe(true);
    }
  });

  it('no .d.ts / .spec.ts / .tsx files are added under client/src (spec-gap-revival eval:232)', () => {
    // A local, fast copy of an eval that only runs under `just eval`. Catching it here saves a
    // full CI round trip, and the eval is the authority either way. RECURSIVE, for the same
    // reason the source walk is (red-team X3): a nested directory must not be a blind spot.
    const entries = readdirSync(OBS_DIR, { recursive: true }) as string[];
    for (const name of entries) {
      for (const banned of ['.d.ts', '.spec.ts', '.tsx']) {
        expect(
          name.endsWith(banned),
          `client/src/observability/${name} is a banned file kind`,
        ).toBe(false);
      }
    }
  });
});

describe('observability/*.ts (T-16b/OBS-16): not one credential-shaped token anywhere', () => {
  it('T-16b: zero occurrences of authorization / bearer / token / credentials / withCredentials', () => {
    // AM3's source half. WRONG IMPL KILLED (the one that motivated the criterion): reusing the
    // SpacetimeDB session token as an OTLP header "so we can correlate sessions". The m20b
    // ingest is deliberately unauthenticated and PUBLIC; a session token posted there is a
    // session-hijack primitive sitting in a log-adjacent pipeline, and Caddy's CORS allows only
    // `content-type` (Caddyfile:54) so the export would fail preflight anyway.
    // WRONG IMPL KILLED (2): a `getToken()` helper wired in behind a feature flag — invisible to
    // the runtime tooth (T-16a) because no test would take that branch.
    //
    // THE SCAN IS OVER RAW SOURCE, COMMENTS INCLUDED. That is deliberate: a commented-out header
    // is a copy-paste away from being live, and a prose mention is one search away from being
    // read as precedent. Describe the absence WITHOUT naming the mechanism, e.g. "the exporter
    // is configured with no request headers at all".
    const sources = readObservabilitySources();
    for (const needle of [
      'authorization',
      'bearer',
      'token',
      'getToken',
      // `credentials:` with the COLON, not the bare word: config.ts legitimately REJECTS an
      // endpoint carrying URL userinfo and its rationale may need to say so in prose. The colon
      // form is what matters — it is the fetch option (`credentials: 'include'`), and
      // `withCredentials` is its XHR twin.
      'credentials:',
      'withCredentials',
      'apiKey',
      'x-api',
    ]) {
      expectAbsent(
        sources,
        needle,
        'OBS-16: the OTLP ingest takes NO auth credential (ops/observability/Caddyfile). Write ' +
          'the rationale in prose without naming the mechanism.',
      );
    }
  });

  it('T-16b-transport: no sendBeacon opt-in (its text/plain body fails the content-type CORS)', () => {
    // Risk R-7. `navigator.sendBeacon` sends `text/plain` unless given a Blob with an explicit
    // type; Caddy allows ONLY the `content-type` request header and the OTLP receiver expects
    // `application/json`. Opting in would make page-hide exports silently 4xx — the hardest
    // class of telemetry bug to notice, because the browser has already navigated away.
    expectAbsentInCode(
      readObservabilitySources(),
      'sendBeacon',
      'R-7: keep the exporter on fetch/XHR so the request carries the content-type the m20b ' +
        'CORS policy and the OTLP receiver both require.',
    );
  });
});

describe('observability/*.ts (T-35a/OBS-34/35): no identity, no player text, ever', () => {
  it('T-35a: zero occurrences of identity / toHexString / nickname / profileName / playerName', () => {
    // OBS-35. `identity` is a module-scope `let` in main.ts (:210) and `toHexString()` is one
    // method call away on every SpacetimeDB Identity, so the leak is always exactly one line of
    // "helpful" code away. A whole-file ban is the only closed form: the runtime teeth cannot
    // prove that no branch anywhere reads it.
    // WRONG IMPL KILLED: `attributes.player = identity.toHexString()` added later "just for
    // debugging a playtest" — 64 hex chars of unbounded, unique-per-player label value on a
    // public ingest, i.e. the cardinality bomb AND the privacy breach in one line.
    //
    // RAW SOURCE, COMMENTS INCLUDED (same reasoning as T-16b): if you need to explain the rule,
    // say "the player's account handle" rather than naming the field.
    const sources = readObservabilitySources();
    for (const needle of ['identity', 'toHexString', 'nickname', 'profileName', 'playerName']) {
      expectAbsent(
        sources,
        needle,
        'OBS-34/35: nothing that names or derives from the player may enter telemetry. NOTE the ' +
          'comment trap: write "the same object REFERENCE" (AM10), never "the same object ' +
          'identity" — this ban reads raw source.',
      );
    }
  });

  it('T-35a-freetext: no reducer-argument or chat/trade free-text surface is imported here', () => {
    // The adjacent leak: importing a module whose values ARE player text (dialogue, trade,
    // rename) puts that text one interpolation away. observability/ needs none of them.
    const sources = readObservabilitySources();
    for (const needle of ['eventRing', 'errorRing', 'bugBundle', 'dialogue', 'tradePropose']) {
      expectAbsentInCode(
        sources,
        needle,
        'ADR-0157 §4 / pt-b1 U-3: player free text lives in those surfaces; telemetry must not ' +
          'be able to reach them.',
      );
    }
  });
});

describe('observability/*.ts (T-A2/AM21): purity — no RegExp, no host globals, no ambient clock', () => {
  it('T-A2: no `new RegExp(`, no `RegExp`, no `.test(`/`.match(` — the predicates are char scans', () => {
    // Semgrep's detect-non-literal-regexp is banned repo-wide and has broken this repo's CI
    // twice. Beyond the lint: a JS regex is a SECOND policy engine next to Alloy's Go/RE2 one,
    // and the two disagree in exactly the places that matter (`$` and a trailing newline,
    // Unicode digit classes, backtracking). names.ts mirrors the ingest with character scans so
    // there is only ever one policy.
    // HONEST LIMIT (stated, not hidden): this ban sees `RegExp`, `.test(`, `.match(`,
    // `.matchAll(` and `.search(`. A regex LITERAL handed to `.split()` or `.replace()` would
    // slip past it — the AM21 rule is "no regex engine", and this closes the spellings that
    // actually get written.
    const sources = readObservabilitySources();
    for (const needle of ['RegExp', '.test(', '.match(', '.matchAll(', '.search(']) {
      expectAbsentInCode(sources, needle, 'T-A2/AM21: hand-rolled character scans only.');
    }
  });

  it('AM21-node: no window / document / navigator / globalThis access — the host is INJECTED', () => {
    // vitest runs these modules in the NODE environment (vite.config.ts:47-53) and main.ts reads
    // the host ONCE, passing a plain `DeviceHints` record in.
    //
    // CORRECTION (red-team X4) — do NOT read this tooth as belt-and-braces over a runtime
    // backstop: Node 24 DEFINES a global `navigator` (and `globalThis`), so a module-scope
    // `navigator.userAgent` read would NOT throw a ReferenceError under vitest. It would quietly
    // return Node's own UA string, `classifyDeviceClass` would classify the TEST RUNNER, and
    // every unit test would still pass. `window`/`document` do throw, but `navigator` — the one
    // this module actually wants — does not. THIS TEXT SCAN IS THE SOLE ENFORCEMENT.
    //
    // Case-sensitive by construction: `frameWindow.frames` contains "Window." (capital W) and
    // must not be mistaken for a `window.` global read — hence the dotted, lower-case needles.
    const sources = readObservabilitySources();
    for (const needle of ['window.', 'document.', 'navigator.', 'globalThis.']) {
      expectAbsentInCode(
        sources,
        needle,
        'AM21: host access is injected (main.ts reads it once and passes DeviceHints in). vitest ' +
          'runs these modules under node with no DOM.',
      );
    }
  });

  it('AM21-clock: no performance.now / Date.now / Math.random — clock and jitter are injected', () => {
    // Every timing input arrives as a parameter: frameTick(state, nowMs), recordRtt(deltaMs),
    // recordWasmReady(readyMs), resolveTelemetryConfig(env, isDev, jitter). That is what makes
    // the whole core deterministic under property tests with no fake timers.
    // WRONG IMPL KILLED: `Math.random()` sampled inside resolveTelemetryConfig — the jitter
    // property (T-21b) could then only assert a range, never the exact ×(1 + 0.1×j) formula, and
    // the resolver would stop being pure.
    const sources = readObservabilitySources();
    for (const needle of ['performance.', 'Date.now', 'Math.random', 'setTimeout', 'setInterval']) {
      expectAbsentInCode(
        sources,
        needle,
        'AM21: clocks, timers and randomness are injected by the caller (frameTick(state, nowMs), ' +
          'recordRtt(deltaMs), resolveTelemetryConfig(env, isDev, jitter)). The export SCHEDULE ' +
          "is the OTel reader's job, driven by the resolved exportIntervalMs.",
      );
    }
  });

  it('AM21-silent: no console writes — telemetry never speaks (the T-I1 ceiling)', () => {
    // The structural companion to T-I1 and to the fail-silent init teeth. A console line in a
    // rarely-taken branch is invisible to the runtime spies but very visible to a playtester,
    // and this code runs at module scope BEFORE main.ts installs its error plumbing.
    const sources = readObservabilitySources();
    for (const sink of [
      'console.log',
      'console.info',
      'console.warn',
      'console.error',
      'console.debug',
    ]) {
      expectAbsentInCode(
        sources,
        sink,
        'T-I1: telemetry degrades silently. Return a reason in the disabled config and let the ' +
          'shell decide whether anything is said.',
      );
    }
  });

  it('the OTel SDK is reachable ONLY through a dynamic import (the chunk stays lazy)', () => {
    // Two things at once: (1) a STATIC import would pull ~30-40KB gz into the main bundle for
    // every player even when telemetry is off, defeating the whole dynamic-import design;
    // (2) it would make every module here un-importable in vitest until the packages are
    // installed, coupling the pure core's tests to a dependency they do not use.
    // `import(` (dynamic) is allowed and expected inside telemetry.ts's default loader.
    const sources = readObservabilitySources();
    expectAbsentInCode(
      sources,
      "from '@opentelemetry",
      'OBS-16 / bundle budget: use the injected loader (deps.loadSdk), whose default ' +
        'implementation is a dynamic import().',
    );
    expectAbsentInCode(sources, 'require(', 'this is an ESM codebase.');

    // The pure core must not reach the SDK by ANY spelling — telemetry.ts is the only file that
    // may name it (inside its dynamic import).
    const pureCore = sources.filter((f) => f.name !== 'telemetry.ts');
    expectAbsentInCode(
      pureCore,
      '@opentelemetry',
      'this module is part of the PURE core: it must be importable, and unit-testable, with the ' +
        'SDK absent entirely.',
    );
  });
});

describe('observability/instruments.ts (AM17 / X5): the table REFERENCES names.ts, textually', () => {
  it('X5: instruments.ts imports from ./names and spells no metric name as a quoted literal', () => {
    // THE PROVEN CHEAT (red-team X5): AM17 in instruments.test.ts compares the instrument-name
    // SET to the names.ts constant SET by VALUE. An implementation that re-spells all eight names
    // as string literals in the table — `{ name: 'mr_client_fps', … }` — produces an identical
    // set and passes it, while the single-source claim AM17 exists to enforce is simply false.
    // The two spellings then drift on the first rename: names.ts changes, the recording rule and
    // the dashboards follow it, and the client keeps emitting the old name with nothing red.
    //
    // Value equality cannot see this — only the SOURCE TEXT can. Comment-stripped (the file's
    // `.code`), so a rationale comment quoting the banned shape does not red a correct table.
    const instruments = readObservabilitySources().find((f) => f.name === 'instruments.ts');
    if (instruments === undefined) {
      throw new Error(
        'observability/instruments.ts not found by the recursive walk — AM17 cannot be checked ' +
          'textually, and this must be a hard red rather than a skip',
      );
    }

    expect(
      instruments.code.includes("from './names'"),
      'instruments.ts must import its names from ./names — that import IS the single source of ' +
        'truth AM17 asserts (and the thing a literal table quietly replaces)',
    ).toBe(true);
    expect(
      instruments.code.includes('METRIC_'),
      'instruments.ts must reference the METRIC_* constants by name',
    ).toBe(true);

    for (const needle of ["name: '", 'name: "', 'name: `']) {
      expect(
        instruments.code.indexOf(needle),
        `instruments.ts must not spell an instrument name as a quoted literal (${needle}…) — ` +
          'every `name:` field must be a METRIC_* constant imported from ./names (AM17)',
      ).toBe(-1);
    }
  });
});
