// SpacetimeDB versions move in lockstep (docs/DECISIONS.md, "SpacetimeDB versions move in
// lockstep"). The CLI and host pin in scripts/ci-tools.sh is the version: the crate pin, its two
// patched copies under vendor/, the lockfile, the npm SDK and the generated bindings name the
// same one, and so does each document that names the version in use. No version is written in
// this file; the pin is read, so the checks hold at every hop. Each reader throws, naming its
// file and what it expected, when its anchor is missing, repeated or malformed, so a moved or
// deleted pin fails instead of reading as a default.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const CI_TOOLS = 'scripts/ci-tools.sh';

const escapeRegex = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// One x.y.z version, captured.
const VERSION = String.raw`(\d+\.\d+\.\d+)`;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const SHELL_VERSION = /^SPACETIME_VERSION=(\d+\.\d+\.\d+)$/;
const SHELL_SHA256 = /^SPACETIME_SHA256=[0-9a-f]{64}$/;
const TOML_HEADER = /^[ \t]*\[\[?[^[\]]+\]\]?[ \t]*(?:#.*)?$/;
const TOML_KEY = /^[ \t]*([A-Za-z0-9_-]+)[ \t]*=/;
const TOML_STRING = /^[ \t]*(?:"([^"\\]*)"|'([^']*)')/;
const TOML_BOOLEAN = /^[ \t]*(true|false)\b/;
const DEP_KEY = /^[ \t]*["']?spacetimedb["']?[ \t]*[.=]/;
const DEP_ENTRY = /^[ \t]*spacetimedb[ \t]*=[ \t]*(.*)$/;
const DEP_STRING = /^"([^"]*)"[ \t]*(?:#.*)?$/;
const CARGO_EXACT = /^=(\d+\.\d+\.\d+)$/;
const PACKAGE_KEY = /^[ \t]*["']?version["']?[ \t]*[.=]/;
const PACKAGE_VERSION = /^[ \t]*version[ \t]*=[ \t]*"(\d+\.\d+\.\d+)"[ \t]*(?:#.*)?$/;
const PRISTINE_CRATE = /^crate (spacetimedb(?:-bindings-sys)?) (\d+\.\d+\.\d+) [0-9a-f]{64}$/;
const NPM_CARET = /^\^(\d+\.\d+\.\d+)$/;
const LOOSE_HEADER = /generated using spacetimedb cli version/;
const HEADER_PREFIX = escapeRegex('// This was generated using spacetimedb cli version ');
const BINDINGS_HEADER = new RegExp(`^${HEADER_PREFIX}${VERSION} \\(commit [0-9a-f]{40}\\)\\.$`);
const CLI_VERSION = /^[ \t]*cliVersion: "(\d+\.\d+\.\d+)" as const,?[ \t]*$/;
const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index';
// The two crates that build from the patched copies under vendor/ (the root [patch.crates-io]).
const VENDORED = ['spacetimedb', 'spacetimedb-bindings-sys'];
// The SpacetimeDB crates the module's build locks, at the least.
const LOCKED = [
  ...VENDORED,
  'spacetimedb-bindings-macro',
  'spacetimedb-lib',
  'spacetimedb-sats',
  'spacetimedb-primitives',
];

// The one line of `lines` that `loose` matches, or a throw naming `file` and `what`.
function oneLine(lines, loose, file, what) {
  const found = lines.filter((line) => loose.test(line));
  if (found.length !== 1) {
    throw new Error(`${file}: expected exactly one ${what}, found ${found.length}`);
  }
  return found[0];
}

// The match of `strict` against `line`, or a throw naming `file` and the form it expected.
function strictMatch(line, strict, file, form) {
  const match = strict.exec(line);
  if (match === null) {
    throw new Error(`${file}: expected ${form}, found ${JSON.stringify(line)}`);
  }
  return match;
}

// `items` listed under `title`, one to a line, for a failure message.
const listed = (title, items) => [title, ...items].join('\n  ');

// The text of `file`, or null with the failure recorded in `failures`.
function readOrReport(file, failures) {
  try {
    return read(file);
  } catch (error) {
    failures.push(`${file}: ${error.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// The pin readers, one per file that names the version
// ---------------------------------------------------------------------------

// The SpacetimeDB CLI and host version scripts/ci-tools.sh pins: its one SPACETIME_VERSION line,
// beside its one SPACETIME_SHA256 line.
function readCiToolsPin(text, file) {
  const lines = text.split('\n');
  const pin = oneLine(lines, /\bSPACETIME_VERSION=/, file, 'SPACETIME_VERSION= line');
  const [, version] = strictMatch(pin, SHELL_VERSION, file, 'SPACETIME_VERSION=x.y.z');
  const sha = oneLine(lines, /\bSPACETIME_SHA256=/, file, 'SPACETIME_SHA256= line');
  strictMatch(sha, SHELL_SHA256, file, 'SPACETIME_SHA256=<64 lower-case hex digits>');
  return version;
}

// The lines of the TOML table `[name]`: from its one header line to the next header line.
function tomlTable(text, name, file) {
  const lines = text.split('\n');
  const headers = [];
  for (const [at, line] of lines.entries()) {
    if (TOML_HEADER.test(line)) {
      headers.push({ at, title: line.replace(/#.*$/, '').trim() });
    }
  }
  const own = headers.filter((header) => header.title === `[${name}]`);
  if (own.length !== 1) {
    throw new Error(`${file}: expected exactly one [${name}] table, found ${own.length}`);
  }
  const next = headers.find((header) => header.at > own[0].at);
  return lines.slice(own[0].at + 1, next?.at ?? lines.length);
}

// The keys of the one-line TOML inline table `src`, each a string, a boolean or an array of
// strings. A dotted, quoted or repeated key, any other value, or anything but a comment after
// the closing brace throws.
function parseInlineTable(src, file, what) {
  let at = 0;
  const fail = (expected) => {
    throw new Error(`${file}: ${what}: expected ${expected} at column ${at + 1} of ${src}`);
  };
  const next = (pattern) => pattern.exec(src.slice(at));
  const take = (pattern, expected) => {
    const match = next(pattern);
    if (match === null) {
      fail(expected);
    }
    at += match[0].length;
    return match;
  };
  const string = () => {
    const [, double, single] = take(TOML_STRING, 'a string');
    return double ?? single;
  };
  const value = () => {
    if (next(TOML_BOOLEAN) !== null) {
      return take(TOML_BOOLEAN, 'a boolean')[1] === 'true';
    }
    if (next(/^[ \t]*\[/) === null) {
      return string();
    }
    take(/^[ \t]*\[/, '`[`');
    const items = [];
    while (next(/^[ \t]*\]/) === null) {
      items.push(string());
      if (next(/^[ \t]*\]/) === null) {
        take(/^[ \t]*,/, '`,` or `]`');
      }
    }
    take(/^[ \t]*\]/, '`]`');
    return items;
  };
  const table = new Map();
  take(/^[ \t]*\{/, '`{`');
  let more = next(/^[ \t]*\}/) === null;
  while (more) {
    const [, key] = take(TOML_KEY, 'a bare key and `=`');
    if (table.has(key)) {
      fail(`one \`${key}\` key`);
    }
    table.set(key, value());
    more = take(/^[ \t]*[,}]/, '`,` or `}`')[0].trim() === ',';
  }
  if (table.size === 0) {
    take(/^[ \t]*\}/, '`}`');
  }
  take(/^[ \t]*(?:#.*)?$/, 'nothing but a comment after the table');
  return table;
}

// The version of the cargo requirement `spec`, which must be exact (`=x.y.z`).
function cargoExact(spec, file, what) {
  const match = CARGO_EXACT.exec(spec);
  if (match === null) {
    throw new Error(
      `${file}: expected ${what} version "=x.y.z" (cargo uses a [patch] entry only when the exact version matches), found ${JSON.stringify(spec)}`,
    );
  }
  return match[1];
}

// The root Cargo.toml's [workspace.dependencies] `spacetimedb` entry: its form (`string` or
// `table`), its exact version and its `features` array, null when the entry has none.
function readWorkspaceSpacetimedb(text, file) {
  const what = '[workspace.dependencies] spacetimedb';
  const body = tomlTable(text, 'workspace.dependencies', file);
  const entry = oneLine(body, DEP_KEY, file, `${what} entry`);
  const [, value] = strictMatch(entry, DEP_ENTRY, file, `a bare key: ${what} = <value>`);
  if (!value.startsWith('{')) {
    const [, spec] = strictMatch(value, DEP_STRING, file, `${what} = "=x.y.z"`);
    return { form: 'string', version: cargoExact(spec, file, what), features: null };
  }
  const table = parseInlineTable(value, file, what);
  const version = table.get('version');
  const features = table.get('features') ?? null;
  if (typeof version !== 'string' || (features !== null && !Array.isArray(features))) {
    throw new Error(`${file}: expected ${what} = { version = "=x.y.z", features = [...] }`);
  }
  return { form: 'table', version: cargoExact(version, file, what), features };
}

// The values of the `key = "..."` lines among the lines of one [[package]] table.
function lockField(lines, key, file) {
  const shape = new RegExp(`^${key} = "([^"]*)"$`);
  return lines
    .filter((line) => line.split('=')[0].trim() === key)
    .map((line) => strictMatch(line, shape, file, `${key} = "..." in [[package]]`)[1]);
}

// The [[package]] tables of Cargo.lock named `spacetimedb` or `spacetimedb-*`, in lock order.
// Each of LOCKED is among them; the VENDORED ones are the path packages under vendor/ (no
// source line), every other one comes from crates.io.
function readLockPackages(text, file) {
  const found = [];
  for (const block of text.split(/^\[\[package\]\][ \t]*$/m).slice(1)) {
    const lines = block.split(/^[ \t]*\[/m)[0].split('\n');
    const names = lockField(lines, 'name', file);
    if (names.length !== 1) {
      throw new Error(`${file}: expected one name per [[package]], found ${names.length}`);
    }
    const [name] = names;
    if (name === 'spacetimedb' || name.startsWith('spacetimedb-')) {
      const versions = lockField(lines, 'version', file);
      const sources = lockField(lines, 'source', file);
      if (versions.length !== 1 || !EXACT_VERSION.test(versions[0]) || sources.length > 1) {
        throw new Error(`${file}: ${name}: expected one version "x.y.z", at most one source`);
      }
      found.push({ name, version: versions[0], source: sources[0] ?? null });
    }
  }
  const missing = LOCKED.filter((name) => !found.some((entry) => entry.name === name));
  if (missing.length > 0) {
    throw new Error(`${file}: expected a [[package]] for each of ${missing.join(', ')}`);
  }
  for (const { name, version, source } of found) {
    const want = VENDORED.includes(name) ? null : CRATES_IO;
    if (source !== want) {
      throw new Error(`${file}: ${name} ${version} has source ${source}, expected ${want}`);
    }
  }
  return found;
}

// The version vendor/PRISTINE.sha256 records for each VENDORED crate, on one `crate` line each.
function readPristine(text, file) {
  const form = 'crate <spacetimedb|spacetimedb-bindings-sys> <x.y.z> <64 hex digits>';
  const versions = {};
  for (const line of text.split('\n').filter((each) => /^[ \t]*crate\b/.test(each))) {
    const [, name, version] = strictMatch(line, PRISTINE_CRATE, file, form);
    if (Object.hasOwn(versions, name)) {
      throw new Error(`${file}: expected exactly one crate ${name} line, found more`);
    }
    versions[name] = version;
  }
  const missing = VENDORED.filter((name) => !Object.hasOwn(versions, name));
  if (missing.length > 0) {
    throw new Error(`${file}: expected a crate line for each of ${missing.join(', ')}`);
  }
  return versions;
}

// The `version` of the [package] table of a vendored crate's Cargo.toml.
function readPackageVersion(text, file) {
  const body = tomlTable(text, 'package', file);
  const line = oneLine(body, PACKAGE_KEY, file, '[package] version');
  return strictMatch(line, PACKAGE_VERSION, file, '[package] version = "x.y.z"')[1];
}

// `text` parsed as JSON, or a throw naming `file`.
function parseJson(text, file) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: expected JSON (${error.message})`);
  }
}

// The version of the npm range `spec`, which must be a caret range (`^x.y.z`).
function npmCaret(spec, file, what) {
  const match = typeof spec === 'string' ? NPM_CARET.exec(spec) : null;
  if (match === null) {
    throw new Error(`${file}: expected ${what} "^x.y.z", found ${JSON.stringify(spec)}`);
  }
  return match[1];
}

// A throw unless `text` holds the JSON key `key` exactly once: JSON.parse keeps the last of two.
function oneKey(text, key, file) {
  const count = text.match(new RegExp(`"${escapeRegex(key)}"\\s*:`, 'g'))?.length ?? 0;
  if (count !== 1) {
    throw new Error(`${file}: expected exactly one "${key}" key, found ${count}`);
  }
}

// The version client/package.json declares for the npm SDK: dependencies.spacetimedb, `^x.y.z`.
function readPackageJsonPin(text, file) {
  oneKey(text, 'spacetimedb', file);
  const spec = parseJson(text, file).dependencies?.spacetimedb;
  return npmCaret(spec, file, 'dependencies.spacetimedb');
}

// What client/package-lock.json locks for the npm SDK: the installed version, and the version of
// the caret range its root package declares.
function readPackageLock(text, file) {
  oneKey(text, 'node_modules/spacetimedb', file);
  const { packages } = parseJson(text, file);
  const installed = packages?.['node_modules/spacetimedb']?.version;
  if (typeof installed !== 'string' || !EXACT_VERSION.test(installed)) {
    const where = "packages['node_modules/spacetimedb'].version";
    throw new Error(`${file}: expected ${where} "x.y.z", found ${JSON.stringify(installed)}`);
  }
  const declared = packages?.['']?.dependencies?.spacetimedb;
  const range = npmCaret(declared, file, "packages[''].dependencies.spacetimedb");
  return { installed, declared: range };
}

// The CLI version the committed bindings name twice: the generated-by header and cliVersion.
function readBindingsPins(text, file) {
  const lines = text.split('\n');
  const headerLine = oneLine(lines, LOOSE_HEADER, file, 'generated-by header line');
  const [, header] = strictMatch(headerLine, BINDINGS_HEADER, file, 'the generated-by header');
  const cliLine = oneLine(lines, /\bcliVersion\b/, file, 'cliVersion line');
  const [, cliVersion] = strictMatch(cliLine, CLI_VERSION, file, 'cliVersion: "x.y.z" as const');
  return { header, cliVersion };
}

// ---------------------------------------------------------------------------
// The document matcher
// ---------------------------------------------------------------------------

// `text` with the blockquote markers that open its lines removed and each run of whitespace,
// newlines included, as one space: a phrase reads the same wrapped, in a table cell, in a code
// block or in a quote.
const flatten = (text) => text.replace(/^[ \t]*(?:>[ \t]?)+/gm, '').replace(/\s+/g, ' ');

// The regex source of a phrase template: its text literal, each `<V>` a captured version.
function phraseSource(template) {
  return flatten(template).split('<V>').map(escapeRegex).join(VERSION);
}

// The versions each occurrence of `template` in `text` captures, one array per occurrence.
function phraseVersions(text, template, flags = '') {
  const pattern = new RegExp(phraseSource(template), `g${flags}`);
  return Array.from(flatten(text).matchAll(pattern), (match) => match.slice(1));
}

// The versions the one occurrence of `template` in `text` captures, or a throw naming `file`.
function readDocAnchor(text, file, template) {
  const found = phraseVersions(text, template);
  if (found.length !== 1) {
    throw new Error(`${file}: expected \`${template}\` exactly once, found ${found.length}`);
  }
  return found[0];
}

// Every x.y.z version written in `text`, in order.
function versionsIn(text) {
  return Array.from(text.matchAll(/\d+\.\d+\.\d+/g), (match) => match[0]);
}

// The versions one markdown table row holds, as [anchor, versions] pairs: the one line of `text`
// that `rowTemplate` matches, each of `cellTemplates` exactly once in that line, and every x.y.z
// version the line writes.
function readRowAnchors(text, file, rowTemplate, cellTemplates) {
  const rows = text.split('\n').filter((line) => phraseVersions(line, rowTemplate).length > 0);
  if (rows.length !== 1) {
    throw new Error(`${file}: expected one line with \`${rowTemplate}\`, found ${rows.length}`);
  }
  const [row] = rows;
  return [
    [rowTemplate, readDocAnchor(row, file, rowTemplate)],
    ...cellTemplates.map((cell) => [`${cell} in that row`, readDocAnchor(row, file, cell)]),
    ['each x.y.z in that row', versionsIn(row)],
  ];
}

// The phrases that name the SpacetimeDB version in use, wherever a document writes them.
const VERSION_IN_USE = [
  'the `spacetime` CLI <V>',
  '`spacetime` CLI/host <V>',
  'npm `spacetimedb` <V>',
  'npm `spacetimedb` all <V>',
  'spacetimedb = "=<V>"',
  'The current pin is <V>',
  'docs.rs/spacetimedb/<V>',
  'bindings are <V>-generated',
  '`SPACETIME_VERSION` <V>',
  'SPACETIME_VERSION=<V>',
];

// Each version-in-use phrase of `text` that names a version other than `pin`, matched without
// regard to case, as { file, shape, version }.
function staleVersionPhrases(text, file, pin) {
  const stale = [];
  for (const shape of VERSION_IN_USE) {
    for (const [version] of phraseVersions(text, shape, 'i')) {
      if (version !== pin) {
        stale.push({ file, shape, version });
      }
    }
  }
  return stale;
}

// Every file under the directory `dir` (relative to the root, at any depth) that `keep` accepts.
function walk(dir, keep) {
  const found = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...walk(rel, keep));
    } else if (keep(entry.name)) {
      found.push(rel);
    }
  }
  return found;
}

// The documents the version scan reads: the root documents, vendor/README.md, every markdown
// file under docs/ and every skill.
function documentScope() {
  return [
    'AGENTS.md',
    'README.md',
    'ARCHITECTURE.md',
    'vendor/README.md',
    ...walk('docs', (name) => name.endsWith('.md')),
    ...walk('.claude/skills', (name) => name === 'SKILL.md'),
  ];
}

// ---------------------------------------------------------------------------
// The repository's files
// ---------------------------------------------------------------------------

// Each file that names the SpacetimeDB version, and what its reader finds there as
// [what, version] pairs.
const PIN_SOURCES = [
  {
    file: 'Cargo.toml',
    pins(text, file) {
      return [['[workspace.dependencies]', readWorkspaceSpacetimedb(text, file).version]];
    },
  },
  {
    file: 'Cargo.lock',
    pins(text, file) {
      return readLockPackages(text, file).map(({ name, version }) => [name, version]);
    },
  },
  {
    file: 'vendor/PRISTINE.sha256',
    pins(text, file) {
      return Object.entries(readPristine(text, file));
    },
  },
  {
    file: 'vendor/spacetimedb/Cargo.toml',
    pins(text, file) {
      return [['[package] version', readPackageVersion(text, file)]];
    },
  },
  {
    file: 'vendor/spacetimedb-bindings-sys/Cargo.toml',
    pins(text, file) {
      return [['[package] version', readPackageVersion(text, file)]];
    },
  },
  {
    file: 'client/package.json',
    pins(text, file) {
      return [['dependencies.spacetimedb', readPackageJsonPin(text, file)]];
    },
  },
  {
    file: 'client/package-lock.json',
    pins(text, file) {
      const { installed, declared } = readPackageLock(text, file);
      return [
        ["packages['node_modules/spacetimedb'].version", installed],
        ["packages[''].dependencies.spacetimedb", declared],
      ];
    },
  },
  {
    file: 'client/src/module_bindings/index.ts',
    pins(text, file) {
      const { header, cliVersion } = readBindingsPins(text, file);
      return [
        ['generated-by header', header],
        ['cliVersion', cliVersion],
      ];
    },
  },
];

// Each document's statement of the SpacetimeDB version in use, as [file, anchor].
const DOC_ANCHORS = [
  ['AGENTS.md', '| spacetime CLI / host + `spacetimedb` crate + npm SDK | <V>, always equal'],
  ['docs/PLAYTEST.md', 'the `spacetime` CLI <V>'],
  ['docs/runbooks/playtest-ops.md', 'The `spacetime` CLI <V> on PATH'],
  ['docs/runbooks/spacetimedb-upgrade.md', 'The current pin is <V>.'],
  ['.claude/skills/spacetimedb-reducer/SKILL.md', '`spacetime` CLI/host <V>'],
  ['.claude/skills/spacetimedb-reducer/SKILL.md', 'Rust `spacetimedb` crate <V>'],
  ['.claude/skills/spacetimedb-reducer/SKILL.md', 'npm `spacetimedb` <V>'],
  ['.claude/skills/spacetimedb-reducer/SKILL.md', 'https://docs.rs/spacetimedb/<V>'],
  ['.claude/skills/spacetimedb-client/SKILL.md', 'npm `spacetimedb` all <V> (`^<V>`'],
  ['.claude/skills/spacetimedb-client/SKILL.md', 'The committed bindings are <V>-generated'],
  ['docs/DECISIONS.md', 'pinned to the same version (<V>: root `Cargo.toml`'],
  ['docs/DECISIONS.md', '(`^<V>`, locked in `client/package-lock.json`)'],
];
// README.md's toolchain row, and the two statements that row makes about the pin.
const README_ROW = '| SpacetimeDB CLI | <V> |';
const README_CELLS = ['`version = "=<V>"`', '`^<V>`'];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('SpacetimeDB pins agree: CLI, crate, vendor copies, lockfile, npm SDK and bindings (lpw-34.1)', () => {
  const pin = readCiToolsPin(read(CI_TOOLS), CI_TOOLS);
  const disagree = [];
  for (const { file, pins } of PIN_SOURCES) {
    try {
      for (const [what, version] of pins(read(file), file)) {
        if (version !== pin) {
          disagree.push(`${file} ${what}: ${version}`);
        }
      }
    } catch (error) {
      disagree.push(error.message);
    }
  }
  assert.deepEqual(disagree, [], listed(`${CI_TOOLS} pins ${pin}; these disagree:`, disagree));
});

test('the pin readers refuse a missing, a repeated or a malformed pin (lpw-34.1)', () => {
  const refuses = (reader, file, cases) => {
    const named = new RegExp(escapeRegex(file));
    for (const [label, text] of cases) {
      assert.throws(() => reader(text, file), named, `${file}: ${label}`);
    }
  };

  // scripts/ci-tools.sh: one SPACETIME_VERSION=x.y.z line, beside one lower-case sha256 line.
  const sha = 'ab'.repeat(32);
  const sha256 = `SPACETIME_SHA256=${sha}`;
  const version = 'SPACETIME_VERSION=2.16.1';
  const shell = (...lines) => [...lines, 'check spacetime "$SPACETIME_VERSION"'].join('\n');
  const pinnedShell = shell('JUST_VERSION=1.58.0', version, sha256);
  assert.equal(readCiToolsPin(pinnedShell, CI_TOOLS), '2.16.1');
  refuses(readCiToolsPin, CI_TOOLS, [
    ['no SPACETIME_VERSION line', shell(sha256)],
    ['two SPACETIME_VERSION lines', shell(version, version, sha256)],
    ['a two-part version', shell('SPACETIME_VERSION=2.16', sha256)],
    ['a quoted version', shell('SPACETIME_VERSION="2.16.1"', sha256)],
    ['an indented assignment', shell(`  ${version}`, sha256)],
    ['an exported assignment', shell(`export ${version}`, sha256)],
    ['no SPACETIME_SHA256 line', shell(version)],
    ['two SPACETIME_SHA256 lines', shell(version, sha256, sha256)],
    ['a short sha256', shell(version, `SPACETIME_SHA256=${sha.slice(1)}`)],
    ['an upper-case sha256', shell(version, sha256.toUpperCase())],
  ]);

  // Cargo.toml: the one spacetimedb entry of [workspace.dependencies], an exact `=x.y.z`, in
  // either form. The entries in [dependencies] and [patch.crates-io] around it are never read.
  const cargo = (...entries) =>
    [
      '[dependencies]',
      'spacetimedb = "=9.9.9"',
      '',
      '[workspace.dependencies]',
      'serde_json = "1"',
      ...entries,
      'log = "0.4"',
      '',
      '[patch.crates-io]',
      'spacetimedb = { path = "vendor/spacetimedb" }',
      '',
    ].join('\n');
  const workspace = (...entries) => readWorkspaceSpacetimedb(cargo(...entries), 'Cargo.toml');
  assert.deepEqual(workspace('spacetimedb = "=2.16.1"'), {
    form: 'string',
    version: '2.16.1',
    features: null,
  });
  assert.deepEqual(workspace('spacetimedb = { version = "=2.16.1", features = ["unstable"] }'), {
    form: 'table',
    version: '2.16.1',
    features: ['unstable'],
  });
  const compact = 'spacetimedb={version="=2.16.1",default-features=false,features=["unstable",]}';
  assert.deepEqual(workspace(compact), {
    form: 'table',
    version: '2.16.1',
    features: ['unstable'],
  });
  const sibling = workspace('spacetimedb-sats = "=1.0.0"', 'spacetimedb = "=2.16.1" # pin');
  assert.equal(sibling.version, '2.16.1');
  const pinned = cargo('spacetimedb = "=2.16.1"');
  refuses(readWorkspaceSpacetimedb, 'Cargo.toml', [
    ['no entry in the table', cargo()],
    ['a version with no =', cargo('spacetimedb = "2.16.1"')],
    ['a caret requirement', cargo('spacetimedb = "^2.16.1"')],
    ['a two-part version', cargo('spacetimedb = "=2.16"')],
    ['a table version with no =', cargo('spacetimedb = { version = "2.16.1" }')],
    ['a table caret version', cargo('spacetimedb = { version = "^2.16.1" }')],
    ['a table with no version', cargo('spacetimedb = { features = ["unstable"] }')],
    ['a repeated key', cargo('spacetimedb = { version = "=2.16.1", version = "=2.16.1" }')],
    ['a features string', cargo('spacetimedb = { version = "=2.16.1", features = "unstable" }')],
    ['text after the table', cargo('spacetimedb = { version = "=2.16.1" } x')],
    ['a table over two lines', cargo('spacetimedb = { version = "=2.16.1",', 'features = [] }')],
    ['a dotted key', cargo('spacetimedb.version = "=2.16.1"')],
    ['two entries', cargo('spacetimedb = "=2.16.1"', 'spacetimedb = "=2.16.1"')],
    ['no [workspace.dependencies] table', '[dependencies]\nspacetimedb = "=2.16.1"\n'],
    ['a second [workspace.dependencies] table', `${pinned}[workspace.dependencies]\n`],
  ]);

  // Cargo.lock: every spacetimedb and spacetimedb-* package with its version, the six the build
  // needs among them, the two vendored ones without a source and the rest from crates.io.
  const hex = 'cd'.repeat(32);
  const pkg = (name, pkgVersion, source) =>
    [
      '[[package]]',
      `name = "${name}"`,
      `version = "${pkgVersion}"`,
      ...(source === null ? [] : [`source = "${source}"`, `checksum = "${hex}"`]),
      'dependencies = [',
      ' "anyhow",',
      ']',
      '',
    ].join('\n');
  const lock = (...packages) => ['version = 4', '', ...packages].join('\n');
  const lockGood = [
    pkg('anyhow', '1.0.98', CRATES_IO),
    pkg('spacetimedb', '2.16.1', null),
    pkg('spacetimedb-bindings-macro', '2.16.1', CRATES_IO),
    pkg('spacetimedb-bindings-sys', '2.16.1', null),
    pkg('spacetimedb-lib', '2.16.1', CRATES_IO),
    pkg('spacetimedb-primitives', '2.16.1', CRATES_IO),
    pkg('spacetimedb-sats', '2.12.0', CRATES_IO),
    pkg('spacetimedbx', '0.1.0', CRATES_IO),
  ];
  assert.deepEqual(readLockPackages(lock(...lockGood), 'Cargo.lock'), [
    { name: 'spacetimedb', version: '2.16.1', source: null },
    { name: 'spacetimedb-bindings-macro', version: '2.16.1', source: CRATES_IO },
    { name: 'spacetimedb-bindings-sys', version: '2.16.1', source: null },
    { name: 'spacetimedb-lib', version: '2.16.1', source: CRATES_IO },
    { name: 'spacetimedb-primitives', version: '2.16.1', source: CRATES_IO },
    { name: 'spacetimedb-sats', version: '2.12.0', source: CRATES_IO },
  ]);
  const without = (name) => lockGood.filter((text) => !text.includes(`name = "${name}"\n`));
  const registryCore = pkg('spacetimedb', '2.16.1', CRATES_IO);
  const pathLib = pkg('spacetimedb-lib', '2.16.1', null);
  const twoVersions = [
    '[[package]]',
    'name = "spacetimedb-auth"',
    'version = "2.16.1"',
    'version = "2.16.1"',
  ].join('\n');
  refuses(readLockPackages, 'Cargo.lock', [
    ['no [[package]] table', 'version = 4\n'],
    ['no spacetimedb-sats', lock(...without('spacetimedb-sats'))],
    ['a crates.io spacetimedb', lock(...without('spacetimedb'), registryCore)],
    ['a path spacetimedb-lib', lock(...without('spacetimedb-lib'), pathLib)],
    ['a package with no version', lock(...lockGood, '[[package]]\nname = "spacetimedb-auth"\n')],
    ['a package with two versions', lock(...lockGood, twoVersions)],
    ['a two-part version', lock(...lockGood, pkg('spacetimedb-auth', '2.16', CRATES_IO))],
    ['an unquoted name', lock(...lockGood, '[[package]]\nname = spacetimedb-auth\n')],
    ['two names in a package', lock(...lockGood, '[[package]]\nname = "a"\nname = "b"\n')],
  ]);

  // vendor/PRISTINE.sha256: one `crate` line for each vendored crate and no other.
  const crate = (name, crateVersion, digest = hex) => `crate ${name} ${crateVersion} ${digest}`;
  const pristine = (...crates) =>
    ['# crate <name> <version> <sha256>', ...crates, `${hex}  spacetimedb/src/lib.rs`].join('\n');
  const sysCrate = 'spacetimedb-bindings-sys';
  const core = crate('spacetimedb', '2.16.1');
  const sys = crate(sysCrate, '2.12.0');
  assert.deepEqual(readPristine(pristine(core, sys), 'vendor/PRISTINE.sha256'), {
    spacetimedb: '2.16.1',
    'spacetimedb-bindings-sys': '2.12.0',
  });
  refuses(readPristine, 'vendor/PRISTINE.sha256', [
    ['no spacetimedb-bindings-sys line', pristine(core)],
    ['two spacetimedb lines', pristine(core, core, sys)],
    ['another crate', pristine(core, sys, crate('spacetimedb-lib', '2.16.1'))],
    ['a short digest', pristine(core, crate(sysCrate, '2.16.1', hex.slice(1)))],
    ['an upper-case digest', pristine(core, crate(sysCrate, '2.16.1', hex.toUpperCase()))],
    ['a two-part version', pristine(core, crate(sysCrate, '2.16'))],
    ['an indented crate line', pristine(core, ` ${sys}`)],
  ]);

  // A vendored crate's Cargo.toml: the one `version` of its [package] table.
  const manifest = (...lines) =>
    [
      '[package]',
      'rust-version = "1.97"',
      'name = "spacetimedb"',
      ...lines,
      '',
      '[dependencies.spacetimedb-lib]',
      'version = "=9.9.9"',
    ].join('\n');
  const vendored = 'vendor/spacetimedb/Cargo.toml';
  assert.equal(readPackageVersion(manifest('version = "2.16.1"'), vendored), '2.16.1');
  refuses(readPackageVersion, vendored, [
    ['no version in [package]', manifest()],
    ['two versions', manifest('version = "2.16.1"', 'version = "2.16.1"')],
    ['a cargo requirement', manifest('version = "=2.16.1"')],
    ['a workspace version', manifest('version.workspace = true')],
    ['a two-part version', manifest('version = "2.16"')],
    ['no [package] table', '[lib]\nversion = "2.16.1"\n'],
  ]);

  // client/package.json: dependencies.spacetimedb, a caret range, the only spacetimedb key.
  const packageJson = (fields) => JSON.stringify({ name: 'client', ...fields }, null, 2);
  const sdk = (range) => packageJson({ dependencies: { spacetimedb: range } });
  assert.equal(readPackageJsonPin(sdk('^2.16.1'), 'client/package.json'), '2.16.1');
  refuses(readPackageJsonPin, 'client/package.json', [
    ['no spacetimedb dependency', packageJson({ dependencies: {} })],
    ['an exact version', sdk('2.16.1')],
    ['a tilde range', sdk('~2.16.1')],
    ['a two-part range', sdk('^2.16')],
    ['two ranges', sdk('^2.16.1 || ^2.12.0')],
    ['a repeated key', '{"dependencies":{"spacetimedb":"^2.16.1","spacetimedb":"^2.16.1"}}'],
    [
      'a second spacetimedb key',
      '{"dependencies":{"spacetimedb":"^2.16.1"},"devDependencies":{"spacetimedb":"^2.16.1"}}',
    ],
    ['not JSON', '{"dependencies":{"spacetimedb":"^2.16.1"}'],
  ]);

  // client/package-lock.json: the installed SDK (a nested copy's key is another key) and the
  // root package's caret range.
  const packageLock = (root, installed) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': root,
        'node_modules/spacetimedb': installed,
        'node_modules/spacetimedb/node_modules/pure-rand': { version: '7.0.1' },
      },
    });
  const npmLock = 'client/package-lock.json';
  const caret = { dependencies: { spacetimedb: '^2.16.1' } };
  const locked = packageLock(caret, { version: '2.12.0' });
  assert.deepEqual(readPackageLock(locked, npmLock), { installed: '2.12.0', declared: '2.16.1' });
  const exactRoot = { dependencies: { spacetimedb: '2.16.1' } };
  const sdkEntry = '"node_modules/spacetimedb":{"version":"2.16.1"}';
  const repeated = `{"packages":{"":${JSON.stringify(caret)},${sdkEntry},${sdkEntry}}}`;
  refuses(readPackageLock, npmLock, [
    ['no installed SDK', packageLock(caret, undefined)],
    ['an installed range', packageLock(caret, { version: '^2.16.1' })],
    ['an installed SDK with no version', packageLock(caret, {})],
    ['no root package', packageLock(undefined, { version: '2.16.1' })],
    ['an exact root range', packageLock(exactRoot, { version: '2.16.1' })],
    ['a repeated installed SDK', repeated],
    ['not JSON', '{"packages":{"node_modules/spacetimedb":{"version":"2.16.1"}}'],
  ]);

  // The bindings' index.ts: the generated-by header, with its 40-hex commit, and cliVersion.
  const commit = '89ab'.repeat(10);
  const header = (cliVersion, hash = commit) =>
    `// This was generated using spacetimedb cli version ${cliVersion} (commit ${hash}).`;
  const cliField = (cliVersion) => `  cliVersion: "${cliVersion}" as const,`;
  const bindings = (...lines) => ['', ...lines, 'export default {};'].join('\n');
  const index = 'client/src/module_bindings/index.ts';
  assert.deepEqual(readBindingsPins(bindings(header('2.16.1'), cliField('2.12.0')), index), {
    header: '2.16.1',
    cliVersion: '2.12.0',
  });
  const pinnedHeader = header('2.16.1');
  const pinnedCli = cliField('2.16.1');
  const noCommit = pinnedHeader.replace(/ \(commit \w+\)/, '');
  refuses(readBindingsPins, index, [
    ['no header', bindings(pinnedCli)],
    ['two headers', bindings(pinnedHeader, pinnedHeader, pinnedCli)],
    ['a header with no commit', bindings(noCommit, pinnedCli)],
    ['a 39-hex commit', bindings(header('2.16.1', commit.slice(1)), pinnedCli)],
    ['a two-part header version', bindings(header('2.16'), pinnedCli)],
    ['an indented header', bindings(` ${pinnedHeader}`, pinnedCli)],
    ['no cliVersion', bindings(pinnedHeader)],
    ['two cliVersion lines', bindings(pinnedHeader, pinnedCli, pinnedCli)],
    ['a cliVersion not as const', bindings(pinnedHeader, '  cliVersion: "2.16.1",')],
    ['a two-part cliVersion', bindings(pinnedHeader, cliField('2.16'))],
  ]);
});

test("the workspace's spacetimedb dependency enables the crate's unstable feature (lpw-34.7)", () => {
  const dep = readWorkspaceSpacetimedb(read('Cargo.toml'), 'Cargo.toml');
  const want = `{ version = "=${dep.version}", features = ["unstable"] }`;
  assert.equal(
    dep.form,
    'table',
    `Cargo.toml: [workspace.dependencies] spacetimedb is the plain string form; expected ${want}`,
  );
  const features = dep.features ?? [];
  assert.ok(
    features.some((feature) => feature === 'unstable'),
    `Cargo.toml: [workspace.dependencies] spacetimedb features ${JSON.stringify(dep.features)} do not hold "unstable"`,
  );
});

test('each document that names the SpacetimeDB version in use names the pin (lpw-34.4)', () => {
  const pin = readCiToolsPin(read(CI_TOOLS), CI_TOOLS);
  const disagree = [];
  const miscounted = [];
  const check = (file, readAnchors) => {
    try {
      for (const [anchor, versions] of readAnchors(read(file))) {
        for (const version of versions.filter((each) => each !== pin)) {
          disagree.push(`${file} | ${anchor} | ${version}`);
        }
      }
    } catch (error) {
      miscounted.push(error.message);
    }
  };
  check('README.md', (text) => readRowAnchors(text, 'README.md', README_ROW, README_CELLS));
  for (const [file, anchor] of DOC_ANCHORS) {
    check(file, (text) => [[anchor, readDocAnchor(text, file, anchor)]]);
  }
  const report = [
    listed(`anchors naming another version than the pin ${pin}:`, disagree),
    listed('anchors matched zero times or more than once, or unreadable:', miscounted),
  ].join('\n');
  assert.deepEqual({ disagree, miscounted }, { disagree: [], miscounted: [] }, report);
});

test('no game document, skill or AGENTS.md uses a version-in-use phrase for another SpacetimeDB version (lpw-34.4)', () => {
  const pin = readCiToolsPin(read(CI_TOOLS), CI_TOOLS);
  const files = documentScope();
  assert.ok(
    files.length >= 30,
    `the walk found ${files.length} documents; the floor of 30 guards against a broken walk`,
  );
  const unreadable = [];
  const stale = [];
  for (const file of files) {
    const text = readOrReport(file, unreadable);
    if (text !== null) {
      for (const { shape, version } of staleVersionPhrases(text, file, pin)) {
        stale.push(`${file} | ${shape} | ${version}`);
      }
    }
  }
  const report = [
    listed(`version-in-use phrases naming another version than the pin ${pin}:`, stale),
    listed('documents that cannot be read:', unreadable),
  ].join('\n');
  assert.deepEqual({ stale, unreadable }, { stale: [], unreadable: [] }, report);
});

test('the document scan sees a version-in-use phrase in prose, in a table and across a line break (lpw-34.4)', () => {
  const pin = '2.16.1';
  const stale = (text) => staleVersionPhrases(text, 'fixture.md', pin);
  const found = (shape) => [{ file: 'fixture.md', shape, version: '2.12.0' }];
  const cli = 'the `spacetime` CLI <V>';

  // Prose wrapped across a line break, with a run of spaces and a tab.
  assert.deepEqual(stale('Rust, the `spacetime`\nCLI  \t2.12.0, Node.\n'), found(cli));
  // A markdown table cell.
  const table = '| Tool | Version |\n|---|---|\n| CLI | the `spacetime` CLI 2.12.0 |\n';
  assert.deepEqual(stale(table), found(cli));
  // A fenced code block: fences are read like prose.
  const fenced = '```toml\n[workspace.dependencies]\nspacetimedb = "=2.12.0"\n```\n';
  assert.deepEqual(stale(fenced), found('spacetimedb = "=<V>"'));
  // A blockquote wrapped across a line break.
  const quoted = '> **Versions.** `spacetime` CLI/host\n> 2.12.0 and the crate\n';
  assert.deepEqual(stale(quoted), found('`spacetime` CLI/host <V>'));
  // A sentence that opens with the phrase.
  assert.deepEqual(stale('The `spacetime` CLI 2.12.0 on PATH.'), found(cli));
  // A wrong version is reported with its file and shape; the pin beside it is not.
  const both = 'npm `spacetimedb` 2.16.1 here, npm `spacetimedb` 2.12.0 there';
  assert.deepEqual(stale(both), found('npm `spacetimedb` <V>'));
  assert.deepEqual(stale('the `spacetime` CLI 2.16.1 and `spacetime` CLI/host 2.16.1'), []);
  // A placeholder is not a version.
  assert.deepEqual(stale('pin it exactly (`spacetimedb = "=<version>"`, or `=$VER`)'), []);
  // Each shape the scan must know, alone: at another version it is reported under that shape,
  // at the pin it is not.
  const shapes = [
    'the `spacetime` CLI <V>',
    '`spacetime` CLI/host <V>',
    'npm `spacetimedb` <V>',
    'npm `spacetimedb` all <V>',
    'spacetimedb = "=<V>"',
    'The current pin is <V>',
    'docs.rs/spacetimedb/<V>',
    'bindings are <V>-generated',
    '`SPACETIME_VERSION` <V>',
    'SPACETIME_VERSION=<V>',
  ];
  for (const shape of shapes) {
    assert.deepEqual(stale(shape.replace('<V>', '2.12.0')), found(shape), shape);
    assert.deepEqual(stale(shape.replace('<V>', pin)), [], shape);
  }

  // The anchor reader: one occurrence, found across a line break, each <V> captured in order;
  // an absent, repeated or look-alike anchor throws, naming the file.
  const pinAnchor = 'The current pin is <V>.';
  const wrapped = 'The current\npin is 2.16.1.';
  assert.deepEqual(readDocAnchor(wrapped, 'f.md', pinAnchor), ['2.16.1']);
  const sdkAnchor = 'npm `spacetimedb` all <V> (`^<V>`';
  const sdkLine = 'npm `spacetimedb` all 2.16.1 (`^2.12.0`, locked)';
  assert.deepEqual(readDocAnchor(sdkLine, 'f.md', sdkAnchor), ['2.16.1', '2.12.0']);
  const docsAnchor = 'https://docs.rs/spacetimedb/<V>';
  const anchorCases = [
    ['an absent anchor', 'no version is named here', pinAnchor],
    ['a repeated anchor', 'The current pin is 2.16.1. The current pin is 2.16.1.', pinAnchor],
    ['a look-alike dot', 'see https://docsXrs/spacetimedb/2.16.1', docsAnchor],
    ['a look-alike end', 'The current pin is 2.16.1!', pinAnchor],
  ];
  for (const [label, text, anchor] of anchorCases) {
    assert.throws(() => readDocAnchor(text, 'f.md', anchor), /f\.md/, label);
  }

  // The table-row reader: the row once, each cell anchor once in that row, and every version
  // the row writes; the next row's versions are not that row's.
  const row = '| SpacetimeDB CLI | <V> |';
  const cells = ['`version = "=<V>"`', '`^<V>`'];
  const tableText = [
    '| Tool | Version | Where |',
    '|---|---|---|',
    '| SpacetimeDB CLI | 2.16.1   | (`version = "=2.16.1"`), (`^2.16.1`); `use 2.12.0` |',
    '| Node | 24.22.3 | `.tool-versions` |',
  ].join('\n');
  assert.deepEqual(readRowAnchors(tableText, 'f.md', row, cells), [
    [row, ['2.16.1']],
    ['`version = "=<V>"` in that row', ['2.16.1']],
    ['`^<V>` in that row', ['2.16.1']],
    ['each x.y.z in that row', ['2.16.1', '2.16.1', '2.16.1', '2.12.0']],
  ]);
  const apart = '| SpacetimeDB CLI | 2.16.1 | `^2.16.1` |\n`version = "=2.16.1"`';
  const rowCases = [
    ['no row', '| Node | 24.22.3 |\n'],
    ['two rows', `${tableText}\n| SpacetimeDB CLI | 2.16.1 | again |\n`],
    ['a cell outside the row', apart],
  ];
  for (const [label, text] of rowCases) {
    assert.throws(() => readRowAnchors(text, 'f.md', row, cells), /f\.md/, label);
  }
});
