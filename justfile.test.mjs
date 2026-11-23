// `just publish` over a database that holds data must re-seed it as the owner: after the publish
// the recipe calls `sync_content` on the same database with the CLI's own identity, and a refused
// call fails the recipe. These tests RUN the real recipe with a recording stand-in for the
// `spacetime` CLI first on PATH.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_REDUCERS } from './scripts/verify-release-reducers.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const JUSTFILE = join(ROOT, 'justfile');
const DB = 'lpw3-sentinel-db-7f3a';
const REFUSAL = 'Error: Response text: sync_content: caller is not the module owner';

// The stand-in: one invocation per line, arguments tab-separated, then the exit code the test
// chose for that subcommand. A refused `call` prints the real CLI's refusal on stderr.
const STAND_IN = `#!/bin/sh
for a in "$@"; do printf '%s\\t' "$a" >> "$MR_FAKE_SPACETIME_LOG"; done
printf '\\n' >> "$MR_FAKE_SPACETIME_LOG"
case "$1" in
  publish) exit "$MR_FAKE_PUBLISH_EXIT" ;;
  call)
    if [ "$MR_FAKE_CALL_EXIT" -ne 0 ]; then
      echo '${REFUSAL}' >&2
    fi
    exit "$MR_FAKE_CALL_EXIT"
    ;;
esac
exit 97
`;

// Run `just publish` with the stand-in answering `publish` and `call` with the given codes.
// Returns the recipe's exit status, its stderr and the recorded invocations (argument arrays).
function runPublish({ publishExit = 0, callExit = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lpw3-just-publish-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const fake = join(bin, 'spacetime');
    writeFileSync(fake, STAND_IN);
    chmodSync(fake, 0o755);
    const log = join(dir, 'spacetime.log');
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith('JUST_') && k !== 'VITE_STDB_DB') env[k] = v;
    }
    Object.assign(env, {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      VITE_STDB_DB: DB,
      // Fail closed: a real spacetime CLI reached instead of the stand-in holds no identity.
      XDG_CONFIG_HOME: join(dir, 'xdg-config'),
      XDG_DATA_HOME: join(dir, 'xdg-data'),
      MR_FAKE_SPACETIME_LOG: log,
      MR_FAKE_PUBLISH_EXIT: String(publishExit),
      MR_FAKE_CALL_EXIT: String(callExit),
    });
    const result = spawnSync(
      'just',
      ['--justfile', JUSTFILE, '--working-directory', ROOT, 'publish'],
      {
        env,
        encoding: 'utf8',
      },
    );
    if (result.error) {
      throw new Error(`could not run \`just\`: ${result.error.message}`);
    }
    assert.notEqual(result.status, null, `just was killed by ${result.signal}`);
    const calls = existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => line.split('\t').slice(0, -1))
      : [];
    return { status: result.status, stderr: result.stderr, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The whole argument list, exactly: the database named, the data kept (no `-c` /
// `--delete-data` in any spelling), the CLI's default server and identity.
function assertPublishOf(args) {
  assert.deepEqual(args, ['publish', '--module-path', 'server-module', DB]);
}

test('after a publish that succeeds, just publish calls sync_content on the same database as the publishing identity', () => {
  const { status, stderr, calls } = runPublish();
  assert.equal(status, 0, `just publish failed: ${stderr}`);
  assert.equal(calls.length, 2, `two invocations, got ${JSON.stringify(calls)}`);
  assertPublishOf(calls[0]);
  assert.deepEqual(calls[1], ['call', DB, 'sync_content']);
});

test('a refused sync_content makes just publish exit non-zero and shows the refusal', () => {
  for (const code of [1, 3]) {
    const { status, stderr, calls } = runPublish({ callExit: code });
    assert.notEqual(status, 0, `a refusal exiting ${code} must fail the recipe`);
    assert.ok(
      stderr.includes(REFUSAL),
      `the refusal reaches the operator (exit ${code}): ${stderr}`,
    );
    assert.equal(calls.length, 2, `two invocations (exit ${code}), got ${JSON.stringify(calls)}`);
    assertPublishOf(calls[0]);
    assert.deepEqual(calls[1], ['call', DB, 'sync_content']);
  }
});

test('a failed publish is not followed by a sync_content call', () => {
  const { status, calls } = runPublish({ publishExit: 1 });
  assert.notEqual(status, 0, 'a failed publish fails the recipe');
  assert.equal(calls.length, 1, `only the publish ran, got ${JSON.stringify(calls)}`);
  assertPublishOf(calls[0]);
});

// ---------------------------------------------------------------------------
// `just release-module <official|world>` and `just module-profile <wasm>`, run for real with a
// recording stand-in for `cargo` first on PATH. The stand-in writes the wasm fixture the test chose
// where cargo would put the artefact, and records its arguments and the four compiler-flag
// variables it receives. Beside it on PATH, a `spacetime` stand-in answers `--version` with a
// `spacetime Path:` line naming a CLI file in a directory off PATH, where a recording stand-in for
// `spacetimedb-standalone` prints the module definition the test chose; a second recording
// `spacetimedb-standalone` on PATH prints the same definition.
// ---------------------------------------------------------------------------

const RUSTFLAGS_VARS = [
  'RUSTFLAGS',
  'CARGO_BUILD_RUSTFLAGS',
  'CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS',
  'CARGO_ENCODED_RUSTFLAGS',
];

// The compiler-override variables: the compiler cargo invokes and the wrappers around it.
const COMPILER_VARS = ['RUSTC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER'];

// One shell line recording whether `v` reached the stand-in, and its value, into `logVar`.
const recordVar = (v, logVar) =>
  `if [ -n "\${${v}+x}" ]; then printf '%s\\tset\\t%s\\n' ${v} "$${v}" >> "$${logVar}"; ` +
  `else printf '%s\\tunset\\n' ${v} >> "$${logVar}"; fi`;

const CARGO_STAND_IN = [
  '#!/bin/sh',
  'for a in "$@"; do printf \'%s\\t\' "$a" >> "$MR_FAKE_CARGO_LOG"; done',
  'printf \'\\n\' >> "$MR_FAKE_CARGO_LOG"',
  ...RUSTFLAGS_VARS.map((v) => recordVar(v, 'MR_FAKE_CARGO_ENV')),
  ...COMPILER_VARS.map((v) => recordVar(v, 'MR_FAKE_CARGO_COMPILER')),
  'if [ "$MR_FAKE_CARGO_EXIT" -ne 0 ]; then',
  "  echo 'error: could not compile `monster-realm-module`' >&2",
  '  exit "$MR_FAKE_CARGO_EXIT"',
  'fi',
  'dir=""',
  'prev=""',
  'for a in "$@"; do',
  '  if [ "$prev" = "--target-dir" ]; then dir="$a"; fi',
  '  prev="$a"',
  'done',
  'if [ "$1" = "build" ] && [ -n "$dir" ]; then',
  '  mkdir -p "$dir/wasm32-unknown-unknown/release"',
  '  cp "$MR_FAKE_WASM" "$dir/wasm32-unknown-unknown/release/monster_realm_module.wasm"',
  '  exit 0',
  'fi',
  'exit 97',
  '',
].join('\n');

// `spacetime --version` as the CLI prints it, its first line naming the CLI's own file
// (`$MR_FAKE_SPACETIME_CLI`, which need not exist). `MR_FAKE_SPACETIME_VERSION=no-path` drops that
// line; any value but `ok` or `no-path` fails the command. Every other subcommand exits 97.
const SPACETIME_VERSION_STAND_IN = [
  '#!/bin/sh',
  'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then',
  '  case "$MR_FAKE_SPACETIME_VERSION" in',
  '    ok) printf \'spacetime Path: %s\\n\' "$MR_FAKE_SPACETIME_CLI" ;;',
  '    no-path) ;;',
  "    *) echo 'error: the spacetime CLI could not start' >&2; exit 1 ;;",
  '  esac',
  "  echo 'Commit: 1a2b3c4'",
  "  echo 'spacetimedb tool version 2.12.0; spacetimedb-lib version 2.12.0;'",
  '  exit 0',
  'fi',
  'exit 97',
  '',
].join('\n');

// The definition extractor beside the CLI's file: records its arguments (one invocation per line,
// tab-separated), each release output that exists when it runs, and a copy of the file it is
// handed; then prints `$MR_FAKE_DEF` and exits `$MR_FAKE_DEF_EXIT`.
const EXTRACTOR_STAND_IN = [
  '#!/bin/sh',
  'for a in "$@"; do printf \'%s\\t\' "$a" >> "$MR_FAKE_DEF_LOG"; done',
  'printf \'\\n\' >> "$MR_FAKE_DEF_LOG"',
  'for f in "$MR_FAKE_RELEASE_DIR"/monster-realm-*; do',
  '  if [ -e "$f" ]; then printf \'%s\\n\' "$f" >> "$MR_FAKE_DEF_OUTPUTS"; fi',
  'done',
  'if [ "$#" -eq 2 ] && [ -f "$2" ]; then cp "$2" "$MR_FAKE_DEF_READ"; fi',
  'printf \'%s\' "$MR_FAKE_DEF"',
  'exit "$MR_FAKE_DEF_EXIT"',
  '',
].join('\n');

// An extractor of the same name first on PATH: it records that it ran and answers as the one
// beside the CLI's file does.
const PATH_EXTRACTOR_STAND_IN = [
  '#!/bin/sh',
  'for a in "$@"; do printf \'%s\\t\' "$a" >> "$MR_FAKE_PATH_DEF_LOG"; done',
  'printf \'\\n\' >> "$MR_FAKE_PATH_DEF_LOG"',
  'printf \'%s\' "$MR_FAKE_DEF"',
  'exit "$MR_FAKE_DEF_EXIT"',
  '',
].join('\n');

// --- module definitions as `spacetimedb-standalone extract-schema <wasm>` prints them: one JSON
// object, each section an object whose one key is its kind.

const reducerDef = (name) => ({
  source_name: name,
  params: { elements: [] },
  visibility: { ClientCallable: [] },
  ok_return_type: { Product: { elements: [] } },
  err_return_type: { String: [] },
});

const DEF_SECTIONS = [
  { Typespace: { types: [{ Product: { elements: [] } }] } },
  { Types: [] },
  { Tables: [] },
  { Reducers: [reducerDef('join_game'), reducerDef('sync_content')] },
  { Views: [] },
  { Schedules: [] },
  { LifeCycleReducers: [] },
  { ExplicitNames: { entries: [] } },
];

const definitionOf = (...sections) => JSON.stringify({ V10: { sections } });

// A clean definition carrying empty HTTP sections, which the check passes: a build may carry
// them empty, and the 2.16.1 build carries none, with the crate's `unstable` feature on or off.
const CLEAN_DEF = definitionOf(...DEF_SECTIONS, { HttpHandlers: [] }, { HttpRoutes: [] });

// --- wasm fixtures: the 8-byte header, then custom sections (id 0, LEB128 size, LEB128 name
// length, name, payload).

function leb128(n) {
  const out = [];
  let rest = n;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    out.push(byte);
  } while (rest !== 0);
  return Buffer.from(out);
}

function customSection(name, payload) {
  const nameBytes = Buffer.from(name, 'utf8');
  const body = Buffer.concat([leb128(nameBytes.length), nameBytes, Buffer.from(payload, 'utf8')]);
  return Buffer.concat([Buffer.from([0x00]), leb128(body.length), body]);
}

const WASM_HEADER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

// A section longer than 127 bytes ahead of the profile, so its size takes two LEB128 bytes.
// Section names a wasm engine gives a meaning to (`name`, `producers`) are avoided.
const PADDING = customSection('fixture.padding', 'p'.repeat(300));

function wasmOf(...sections) {
  return Buffer.concat([WASM_HEADER, PADDING, ...sections, customSection('fixture.trailer', 'z')]);
}

const profileSection = (text) => customSection('mr_build_profile', text);

const PRODUCTION_ISSUER = `https:${'//'}auth.monster-realm.invalid/`;
const OFFICIAL_TEXT =
  'profile=official\nenforces_ownership=true\ndev_reducers=false\n' +
  `login_issuer=${PRODUCTION_ISSUER}\n`;
const WORLD_TEXT = 'profile=world\nenforces_ownership=true\ndev_reducers=false\n';
const GOOD = {
  official: wasmOf(profileSection(OFFICIAL_TEXT)),
  world: wasmOf(profileSection(WORLD_TEXT)),
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function buildArgs(profile, targetRoot) {
  return [
    'build',
    '--locked',
    '-p',
    'monster-realm-module',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
    '--no-default-features',
    '--features',
    profile,
    '--target-dir',
    `${targetRoot}/release-module/${profile}`,
  ];
}

// Every file under `root`, as a path relative to it.
const listFiles = (root, rel = '') =>
  readdirSync(join(root, rel), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(root, join(rel, entry.name)) : [join(rel, entry.name)],
  );

// Run `just <args>` from a fresh temp dir with the cargo and spacetime stand-ins first on PATH.
// `wasm` is what the cargo stand-in builds; `env(dir)` adds variables; `preseed` writes a good
// artefact where a release build would land before the recipe runs, and `leftover` the bytes of
// one where a default build lands. `def` and `defExit` are what the definition extractor prints
// and exits with; `spacetimeVersion` is `ok`, `no-path` or `fail`. Returns everything the
// assertions need, read before the temp dir is removed.
function runJust(
  args,
  {
    wasm = null,
    cargoExit = 0,
    env: extra = () => ({}),
    preseed = null,
    leftover = null,
    def = CLEAN_DEF,
    defExit = 0,
    spacetimeVersion = 'ok',
  } = {},
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'acs6-just-')));
  try {
    const install = (path, text) => {
      writeFileSync(path, text);
      chmodSync(path, 0o755);
    };
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    install(join(bin, 'cargo'), CARGO_STAND_IN);
    install(join(bin, 'spacetime'), SPACETIME_VERSION_STAND_IN);
    install(join(bin, 'spacetimedb-standalone'), PATH_EXTRACTOR_STAND_IN);
    // The CLI's own directory, off PATH.
    const cliDir = join(dir, 'spacetime-cli');
    mkdirSync(cliDir);
    install(join(cliDir, 'spacetimedb-standalone'), EXTRACTOR_STAND_IN);
    const fixture = join(dir, 'fixture.wasm');
    if (wasm) writeFileSync(fixture, wasm);
    if (preseed) {
      const built = join(
        dir,
        'target',
        'release-module',
        preseed.profile,
        'wasm32-unknown-unknown',
        'release',
      );
      mkdirSync(built, { recursive: true });
      writeFileSync(join(built, 'monster_realm_module.wasm'), preseed.wasm);
    }
    if (leftover) {
      const built = join(dir, 'target', 'wasm32-unknown-unknown', 'release');
      mkdirSync(built, { recursive: true });
      writeFileSync(join(built, 'monster_realm_module.wasm'), leftover);
    }
    const log = join(dir, 'cargo.log');
    const envLog = join(dir, 'cargo.env');
    const compilerLog = join(dir, 'cargo.compiler');
    const defLog = join(dir, 'extractor.log');
    const pathDefLog = join(dir, 'extractor-on-path.log');
    const defOutputs = join(dir, 'extractor.outputs');
    const defRead = join(dir, 'extractor.read');
    const extraEnv = extra(dir);
    const targetRoot = extraEnv.CARGO_TARGET_DIR ?? join(dir, 'target');
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (
        k.startsWith('JUST_') ||
        k === 'CARGO_TARGET_DIR' ||
        RUSTFLAGS_VARS.includes(k) ||
        COMPILER_VARS.includes(k)
      ) {
        continue;
      }
      env[k] = v;
    }
    Object.assign(
      env,
      {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        MR_FAKE_CARGO_LOG: log,
        MR_FAKE_CARGO_ENV: envLog,
        MR_FAKE_CARGO_COMPILER: compilerLog,
        MR_FAKE_CARGO_EXIT: String(cargoExit),
        MR_FAKE_WASM: fixture,
        MR_FAKE_SPACETIME_VERSION: spacetimeVersion,
        MR_FAKE_SPACETIME_CLI: join(cliDir, 'spacetimedb-cli'),
        MR_FAKE_DEF: def,
        MR_FAKE_DEF_EXIT: String(defExit),
        MR_FAKE_DEF_LOG: defLog,
        MR_FAKE_PATH_DEF_LOG: pathDefLog,
        MR_FAKE_DEF_OUTPUTS: defOutputs,
        MR_FAKE_DEF_READ: defRead,
        MR_FAKE_RELEASE_DIR: join(targetRoot, 'release-module'),
      },
      extraEnv,
    );
    const argv = typeof args === 'function' ? args({ dir, fixture }) : args;
    const result = spawnSync(
      'just',
      ['--justfile', JUSTFILE, '--working-directory', dir, ...argv],
      {
        env,
        encoding: 'utf8',
      },
    );
    if (result.error) {
      throw new Error(`could not run \`just\`: ${result.error.message}`);
    }
    assert.notEqual(result.status, null, `just was killed by ${result.signal}`);
    const readCalls = (file) =>
      existsSync(file)
        ? readFileSync(file, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => line.split('\t').slice(0, -1))
        : [];
    const calls = readCalls(log);
    const readRecords = (file) =>
      existsSync(file)
        ? readFileSync(file, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => line.split('\t'))
        : [];
    const flags = readRecords(envLog);
    const compiler = readRecords(compilerLog);
    const outputsUnder = (root, profile) => {
      const copy = join(root, 'release-module', `monster-realm-${profile}.wasm`);
      const sum = `${copy}.sha256`;
      return {
        copyPath: copy,
        copy: existsSync(copy) ? readFileSync(copy) : null,
        sum: existsSync(sum) ? readFileSync(sum, 'utf8') : null,
      };
    };
    return {
      dir,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls,
      flags,
      compiler,
      targetRoot,
      outputs: {
        official: outputsUnder(targetRoot, 'official'),
        world: outputsUnder(targetRoot, 'world'),
      },
      extractions: readCalls(defLog),
      pathExtractions: readCalls(pathDefLog),
      outputsAtExtraction: existsSync(defOutputs)
        ? readFileSync(defOutputs, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
        : [],
      extractedBytes: existsSync(defRead) ? readFileSync(defRead) : null,
      files: listFiles(dir).sort(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const lastLine = (text) => text.trimEnd().split('\n').at(-1);

function assertNoOutputs(run, profile, label) {
  const out = run.outputs[profile];
  assert.equal(out.copy, null, `${label}: no copy of the artefact is written`);
  assert.equal(out.sum, null, `${label}: no .sha256 is written`);
}

function assertAccepted(run, profile, artefact) {
  assert.equal(run.status, 0, `release-module ${profile} failed: ${run.stderr}`);
  const out = run.outputs[profile];
  assert.ok(out.copy, `the copy exists at ${out.copyPath}`);
  assert.ok(out.copy.equals(artefact), 'the copy is byte-identical to the built artefact');
  const hex = sha256(artefact);
  assert.equal(out.sum, `${hex}  monster-realm-${profile}.wasm\n`, 'the .sha256 file');
  assert.equal(
    lastLine(run.stdout),
    `release-module: ${profile} ${hex} ${out.copyPath}`,
    'the last stdout line names the profile, the hash and the absolute path of the copy',
  );
}

for (const bad of ['dev', 'test', 'official,world', '', 'Official', 'official ', 'default']) {
  test(`release-module ${JSON.stringify(bad)} exits 64, says why on stderr and never runs cargo`, () => {
    const run = runJust(['release-module', bad], { wasm: GOOD.official });
    assert.equal(run.status, 64, `exit status for ${JSON.stringify(bad)}: ${run.stderr}`);
    assert.ok(run.stderr.trim().length > 0, 'a line on stderr');
    assert.deepEqual(run.calls, [], 'cargo is never run');
    assertNoOutputs(run, 'official', JSON.stringify(bad));
  });
}

const EXPORTED_FLAGS = {
  RUSTFLAGS: '-C debug-assertions=on',
  CARGO_BUILD_RUSTFLAGS: '--cfg feature="open_join"',
  CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: '--cfg feature="dev_reducers"',
  // Cargo's encoded form separates flags with the unit separator, 0x1f.
  CARGO_ENCODED_RUSTFLAGS: `--cfg${String.fromCharCode(0x1f)}feature="open_join"`,
};

const CLEARED_FLAGS = [
  ['RUSTFLAGS', 'unset'],
  ['CARGO_BUILD_RUSTFLAGS', 'unset'],
  ['CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS', 'unset'],
  ['CARGO_ENCODED_RUSTFLAGS', 'set', ''],
];

// Path-like values a caller could export to swap the compiler cargo runs.
const EXPORTED_COMPILER = {
  RUSTC: '/nonexistent/rustc',
  RUSTC_WRAPPER: '/nonexistent/wrapper',
  RUSTC_WORKSPACE_WRAPPER: '/nonexistent/workspace-wrapper',
};

const CLEARED_COMPILER = [
  ['RUSTC', 'unset'],
  ['RUSTC_WRAPPER', 'unset'],
  ['RUSTC_WORKSPACE_WRAPPER', 'unset'],
];

for (const profile of ['official', 'world']) {
  test(`release-module ${profile} runs one cargo build, the feature alone, compiler flags cleared whatever the caller exported`, () => {
    const run = runJust(['release-module', profile], {
      wasm: GOOD[profile],
      env: () => ({ ...EXPORTED_FLAGS, ...EXPORTED_COMPILER }),
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.calls, [buildArgs(profile, 'target')], 'exactly this one cargo command');
    assert.deepEqual(run.flags, CLEARED_FLAGS, 'the compiler-flag variables cargo was handed');
    assert.deepEqual(
      run.compiler,
      CLEARED_COMPILER,
      'the compiler and wrapper variables are unset for cargo',
    );
  });
}

test('release-module official sets CARGO_ENCODED_RUSTFLAGS empty when the caller exported nothing', () => {
  const run = runJust(['release-module', 'official'], { wasm: GOOD.official });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.calls, [buildArgs('official', 'target')]);
  assert.deepEqual(run.flags, CLEARED_FLAGS);
  assert.deepEqual(run.compiler, CLEARED_COMPILER);
});

test('release-module builds into and writes under $CARGO_TARGET_DIR when it is set', () => {
  const run = runJust(['release-module', 'official'], {
    wasm: GOOD.official,
    env: (dir) => ({ CARGO_TARGET_DIR: join(dir, 'shared-target') }),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.calls, [buildArgs('official', run.targetRoot)]);
  assertAccepted(run, 'official', GOOD.official);
});

for (const profile of ['official', 'world']) {
  test(`release-module ${profile} accepts a good ${profile} artefact: the copy, its .sha256 and the last stdout line`, () => {
    const run = runJust(['release-module', profile], { wasm: GOOD[profile] });
    assert.equal(run.calls.length, 1, 'one cargo command');
    assertAccepted(run, profile, GOOD[profile]);
  });
}

const OFFICIAL_LINES = [
  'profile=official',
  'enforces_ownership=true',
  'dev_reducers=false',
  `login_issuer=${PRODUCTION_ISSUER}`,
];
const linesText = (lines) => `${lines.join('\n')}\n`;
const officialWith = (i, line) => linesText(OFFICIAL_LINES.map((l, j) => (j === i ? line : l)));

const REFUSALS = [
  ['official', 'no mr_build_profile section', wasmOf()],
  [
    'official',
    'two mr_build_profile sections',
    wasmOf(profileSection(OFFICIAL_TEXT), profileSection(OFFICIAL_TEXT)),
  ],
  ['official', 'profile=test', wasmOf(profileSection(officialWith(0, 'profile=test')))],
  [
    'official',
    'profile=world when official was asked',
    wasmOf(profileSection(linesText(['profile=world', ...OFFICIAL_LINES.slice(1)]))),
  ],
  [
    'world',
    'profile=official when world was asked',
    wasmOf(profileSection(linesText(['profile=official', ...OFFICIAL_LINES.slice(1, 3)]))),
  ],
  [
    'official',
    'enforces_ownership=false',
    wasmOf(profileSection(officialWith(1, 'enforces_ownership=false'))),
  ],
  ['official', 'dev_reducers=true', wasmOf(profileSection(officialWith(2, 'dev_reducers=true')))],
  [
    'official',
    'no enforces_ownership line',
    wasmOf(profileSection(linesText(OFFICIAL_LINES.filter((_, j) => j !== 1)))),
  ],
  [
    'official',
    'no dev_reducers line',
    wasmOf(profileSection(linesText(OFFICIAL_LINES.filter((_, j) => j !== 2)))),
  ],
  [
    'official',
    'official with no issuer',
    wasmOf(profileSection(linesText(OFFICIAL_LINES.slice(0, 3)))),
  ],
  [
    'official',
    'official with two issuers',
    wasmOf(
      profileSection(
        linesText([...OFFICIAL_LINES, `login_issuer=https:${'//'}auth.monster-realm.example/`]),
      ),
    ),
  ],
  [
    'official',
    'official with an http: issuer',
    wasmOf(profileSection(officialWith(3, `login_issuer=http:${'//'}auth.monster-realm.invalid/`))),
  ],
  [
    'world',
    'world with an issuer',
    wasmOf(profileSection(`${WORLD_TEXT}login_issuer=${PRODUCTION_ISSUER}\n`)),
  ],
  [
    'official',
    'a profile=officialx line',
    wasmOf(profileSection(officialWith(0, 'profile=officialx'))),
  ],
  [
    'official',
    'a xprofile=official line',
    wasmOf(profileSection(officialWith(0, 'xprofile=official'))),
  ],
  ...FORBIDDEN_REDUCERS.map((name) => [
    'official',
    `an artefact whose bytes contain ${name}`,
    wasmOf(profileSection(OFFICIAL_TEXT), customSection('reducers', name)),
  ]),
];

for (const [profile, label, artefact] of REFUSALS) {
  test(`release-module ${profile} refuses ${label}, exiting non-zero and writing neither output`, () => {
    const run = runJust(['release-module', profile], { wasm: artefact });
    assert.equal(run.calls.length, 1, `the build ran (${label}): ${JSON.stringify(run.calls)}`);
    assert.notEqual(run.status, 0, `${label} must be refused`);
    assertNoOutputs(run, profile, label);
  });
}

test('release-module fails when cargo fails, even over a good artefact a previous build left', () => {
  const run = runJust(['release-module', 'official'], {
    wasm: GOOD.official,
    cargoExit: 101,
    preseed: { profile: 'official', wasm: GOOD.official },
  });
  assert.equal(run.calls.length, 1, 'the build ran');
  assert.notEqual(run.status, 0, 'a failing cargo fails the recipe');
  assertNoOutputs(run, 'official', 'a failing cargo');
});

// --- the release artefact's module definition, read through the extractor beside the CLI's file.

const PROFILE_TEXT = { official: OFFICIAL_TEXT, world: WORLD_TEXT };

// The artefact the recipe built, as it names it: cargo's target directory, then cargo's path in it.
const builtOf = (run) =>
  `${run.calls[0].at(-1)}/wasm32-unknown-unknown/release/monster_realm_module.wasm`;

// Refused over the definition: the build ran, the recipe exits non-zero and writes neither output,
// a stderr line begins `release-module: refusing <built>: `, and stderr names each line of `named`.
function assertRefusedOverDefinition(run, profile, label, named = []) {
  assert.equal(run.calls.length, 1, `${label}: the build ran: ${JSON.stringify(run.calls)}`);
  assert.notEqual(run.status, 0, `${label}: refused`);
  assertNoOutputs(run, profile, label);
  const prefix = `release-module: refusing ${builtOf(run)}: `;
  assert.ok(
    run.stderr.split('\n').some((line) => line.startsWith(prefix)),
    `${label}: a stderr line begins ${JSON.stringify(prefix)}: ${run.stderr}`,
  );
  for (const line of named) {
    assert.ok(
      run.stderr.includes(line),
      `${label}: stderr names ${JSON.stringify(line)}: ${run.stderr}`,
    );
  }
}

const SECTIONS_WITHOUT_REDUCERS = DEF_SECTIONS.filter((s) => !Object.hasOwn(s, 'Reducers'));

// Definitions that declare what the access design refuses, each with the lines that name it.
const DECLARING_DEFINITIONS = [
  [
    'an HTTP handler',
    definitionOf(
      ...DEF_SECTIONS,
      { HttpHandlers: [{ source_name: 'on_webhook' }] },
      { HttpRoutes: [] },
    ),
    ['HTTP handler `on_webhook`'],
  ],
  [
    'an HTTP route',
    definitionOf(
      ...DEF_SECTIONS,
      { HttpHandlers: [] },
      {
        HttpRoutes: [
          { handler_function: 'on_webhook', method: { Any: [] }, path: '/hooks/payment' },
        ],
      },
    ),
    ['HTTP route `/hooks/payment` to handler `on_webhook`'],
  ],
  [
    'a row filter',
    definitionOf(...DEF_SECTIONS, {
      RowLevelSecurity: [{ sql: 'SELECT * FROM player WHERE identity = :sender' }],
    }),
    ['row filter `SELECT * FROM player WHERE identity = :sender`'],
  ],
  [
    'an HTTP handler inside a submodule',
    definitionOf(...DEF_SECTIONS, {
      Submodules: [
        {
          namespace: 'payments',
          module: { sections: [{ HttpHandlers: [{ source_name: 'on_callback' }] }] },
        },
      ],
    }),
    ['submodule `payments`: HTTP handler `on_callback`'],
  ],
  [
    'a row filter and an HTTP handler',
    definitionOf(
      ...DEF_SECTIONS,
      { RowLevelSecurity: [{ sql: 'SELECT * FROM config' }] },
      { HttpHandlers: [{ source_name: 'on_ping' }] },
    ),
    ['row filter `SELECT * FROM config`', 'HTTP handler `on_ping`'],
  ],
];

// The `runJust` options under which the definition cannot be read.
const UNREADABLE_DEFINITIONS = [
  ['the extractor exits 1 over a clean definition', { defExit: 1 }],
  ['the extractor exits 2 printing nothing', { def: '', defExit: 2 }],
  ['the extractor prints nothing', { def: '' }],
  ['the extractor prints no JSON', { def: 'error: the module did not load' }],
  [
    'a V10 definition with no Reducers section',
    { def: definitionOf(...SECTIONS_WITHOUT_REDUCERS) },
  ],
  [
    'a V10 definition with an empty Reducers section',
    { def: definitionOf(...SECTIONS_WITHOUT_REDUCERS, { Reducers: [] }) },
  ],
  ['a V9 definition', { def: JSON.stringify({ V9: { sections: DEF_SECTIONS } }) }],
  ['spacetime --version prints no Path line', { spacetimeVersion: 'no-path' }],
  ['spacetime --version fails', { spacetimeVersion: 'fail' }],
];

for (const profile of ['official', 'world']) {
  test(`release-module ${profile} refuses an artefact whose definition declares an HTTP handler, route or row filter (lpw-34.6)`, () => {
    for (const [label, def, named] of DECLARING_DEFINITIONS) {
      const run = runJust(['release-module', profile], { wasm: GOOD[profile], def });
      assertRefusedOverDefinition(run, profile, label, named);
    }
  });

  test(`release-module ${profile} refuses when the definition cannot be read (lpw-34.6)`, () => {
    for (const [label, options] of UNREADABLE_DEFINITIONS) {
      const run = runJust(['release-module', profile], { wasm: GOOD[profile], ...options });
      assertRefusedOverDefinition(run, profile, label);
      assert.deepEqual(run.pathExtractions, [], `${label}: no extractor found on PATH runs`);
    }
  });

  test(`release-module ${profile} reads the definition of exactly the built artefact, once (lpw-34.6)`, () => {
    const run = runJust(['release-module', profile], { wasm: GOOD[profile] });
    assertAccepted(run, profile, GOOD[profile]);
    assert.equal(
      run.stdout,
      `release-module: ${profile} ${sha256(GOOD[profile])} ${run.outputs[profile].copyPath}\n`,
      'stdout is the one release line, the definition not echoed',
    );
    assert.equal(run.extractions.length, 1, `one extraction: ${JSON.stringify(run.extractions)}`);
    const [call] = run.extractions;
    assert.equal(call.length, 2, `extract-schema and one path: ${JSON.stringify(call)}`);
    assert.equal(call[0], 'extract-schema');
    assert.equal(
      resolve(run.dir, call[1]),
      resolve(run.dir, builtOf(run)),
      'the extractor reads the artefact cargo built',
    );
    assert.ok(
      run.extractedBytes?.equals(GOOD[profile]),
      'the file handed to the extractor holds the built bytes',
    );
    assert.deepEqual(
      run.outputsAtExtraction,
      [],
      'no release output exists when the definition is read',
    );
    assert.deepEqual(
      run.pathExtractions,
      [],
      'the extractor beside the CLI file runs, never one found on PATH',
    );

    // Under $CARGO_TARGET_DIR the artefact read is the one built there.
    const shared = runJust(['release-module', profile], {
      wasm: GOOD[profile],
      env: (dir) => ({ CARGO_TARGET_DIR: join(dir, 'shared-target') }),
    });
    assertAccepted(shared, profile, GOOD[profile]);
    assert.deepEqual(
      shared.extractions.map((c) => c.map((a, i) => (i === 1 ? resolve(shared.dir, a) : a))),
      [
        [
          'extract-schema',
          join(
            shared.targetRoot,
            'release-module',
            profile,
            'wasm32-unknown-unknown',
            'release',
            'monster_realm_module.wasm',
          ),
        ],
      ],
      'under $CARGO_TARGET_DIR: one extraction, of the artefact built there',
    );
    assert.deepEqual(shared.pathExtractions, [], 'under $CARGO_TARGET_DIR: none from PATH');

    // An artefact the profile and dev-reducer checks refuse is refused before its definition is
    // read: the first of those checks and the last.
    for (const [label, artefact] of [
      ['an artefact with no mr_build_profile section', wasmOf()],
      [
        `an artefact whose bytes contain ${FORBIDDEN_REDUCERS[0]}`,
        wasmOf(
          profileSection(PROFILE_TEXT[profile]),
          customSection('reducers', FORBIDDEN_REDUCERS[0]),
        ),
      ],
    ]) {
      const bad = runJust(['release-module', profile], { wasm: artefact });
      assert.equal(bad.calls.length, 1, `${label}: the build ran`);
      assert.notEqual(bad.status, 0, `${label}: refused`);
      assertNoOutputs(bad, profile, label);
      assert.deepEqual(bad.extractions, [], `${label}: the definition is never read`);
      assert.deepEqual(bad.pathExtractions, [], `${label}: no extractor on PATH runs`);
    }
  });
}

// --- `just module-definition`: the default build's module definition, read the same way.

// The module alone with its default features, as `spacetime build` builds it, from the committed
// lock file, into `targetRoot`.
const defaultBuildArgs = (targetRoot) => [
  'build',
  '--locked',
  '-p',
  'monster-realm-module',
  '--release',
  '--target',
  'wasm32-unknown-unknown',
  '--target-dir',
  targetRoot,
];

// A default build's artefact: its profile is no release profile.
const DEFAULT_BUILD = wasmOf(
  profileSection('profile=test\nenforces_ownership=false\ndev_reducers=false\n'),
);

// The default build's artefact under the run's target root.
const defaultBuilt = (run) =>
  join(run.targetRoot, 'wasm32-unknown-unknown', 'release', 'monster_realm_module.wasm');

// The files the harness itself leaves in a run's directory: the fixture and the stand-ins' records,
// and the stand-ins under these two directories.
const HARNESS_FILES = new Set([
  'fixture.wasm',
  'cargo.log',
  'cargo.env',
  'cargo.compiler',
  'extractor.log',
  'extractor-on-path.log',
  'extractor.outputs',
  'extractor.read',
]);
const HARNESS_DIRS = ['bin/', 'spacetime-cli/'];

// Every other file the run left: cargo's artefact, and whatever the recipe wrote.
const leftByRun = (run) =>
  run.files.filter((f) => !HARNESS_FILES.has(f) && !HARNESS_DIRS.some((d) => f.startsWith(d)));

const DEFINITION_LINE = 'module-definition: ';
const DEFINITION_REFUSAL = 'module-definition: refusing ';
const DEFINITION_CLEAN = ' declares no HTTP handler, HTTP route or row filter';

// Accepted: exit 0; one extraction, by the extractor beside the CLI's file, of exactly the built
// artefact; the last stdout line names that artefact as clean; no file beside cargo's artefact.
function assertDefinitionClean(run, label, artefact) {
  assert.equal(run.status, 0, `${label}: module-definition failed: ${run.stderr}`);
  const built = defaultBuilt(run);
  assert.equal(
    run.extractions.length,
    1,
    `${label}: one extraction: ${JSON.stringify(run.extractions)}`,
  );
  const [call] = run.extractions;
  assert.equal(call.length, 2, `${label}: extract-schema and one path: ${JSON.stringify(call)}`);
  assert.equal(call[0], 'extract-schema', label);
  assert.equal(
    resolve(run.dir, call[1]),
    built,
    `${label}: the extractor reads the artefact cargo built`,
  );
  assert.ok(
    run.extractedBytes?.equals(artefact),
    `${label}: the file handed to the extractor holds the built bytes`,
  );
  assert.deepEqual(run.pathExtractions, [], `${label}: never an extractor found on PATH`);
  const line = lastLine(run.stdout);
  assert.ok(
    line.startsWith(DEFINITION_LINE) && line.endsWith(DEFINITION_CLEAN),
    `${label}: the last stdout line: ${JSON.stringify(line)}`,
  );
  assert.equal(
    resolve(run.dir, line.slice(DEFINITION_LINE.length, -DEFINITION_CLEAN.length)),
    built,
    `${label}: the last stdout line names the built artefact`,
  );
  assert.deepEqual(
    leftByRun(run),
    [relative(run.dir, built)],
    `${label}: no file written beside cargo's artefact`,
  );
}

// Refused: the build ran, the recipe exits non-zero and writes no file beside cargo's artefact,
// and a stderr line begins `module-definition: refusing <built>: ` and names each of `named`.
function assertDefinitionRefused(run, label, named = []) {
  assert.equal(run.calls.length, 1, `${label}: the build ran: ${JSON.stringify(run.calls)}`);
  assert.notEqual(run.status, 0, `${label}: refused`);
  const built = defaultBuilt(run);
  const refusals = run.stderr.split('\n').filter((l) => {
    if (!l.startsWith(DEFINITION_REFUSAL)) return false;
    const rest = l.slice(DEFINITION_REFUSAL.length);
    const end = rest.indexOf(': ');
    return end > 0 && resolve(run.dir, rest.slice(0, end)) === built;
  });
  assert.ok(
    refusals.length > 0,
    `${label}: a stderr line begins ${JSON.stringify(`${DEFINITION_REFUSAL}<built>: `)}: ${run.stderr}`,
  );
  for (const line of named) {
    assert.ok(
      refusals.some((r) => r.includes(line)),
      `${label}: the refusal names ${JSON.stringify(line)}: ${run.stderr}`,
    );
  }
  assert.deepEqual(
    leftByRun(run),
    [relative(run.dir, built)],
    `${label}: no file written beside cargo's artefact`,
  );
}

test('module-definition builds the module with its default features and reads the definition of exactly that build, once (lpw-34.6)', () => {
  const run = runJust(['module-definition'], { wasm: DEFAULT_BUILD });
  assert.deepEqual(run.calls, [defaultBuildArgs('target')], 'exactly this one cargo command');
  assertDefinitionClean(run, 'the default target directory', DEFAULT_BUILD);

  // A definition with no HTTP section at all reads as clean too.
  const plain = runJust(['module-definition'], {
    wasm: DEFAULT_BUILD,
    def: definitionOf(...DEF_SECTIONS),
  });
  assert.deepEqual(plain.calls, [defaultBuildArgs('target')], 'no HTTP section: the one build');
  assertDefinitionClean(plain, 'no HTTP section', DEFAULT_BUILD);

  const shared = runJust(['module-definition'], {
    wasm: DEFAULT_BUILD,
    env: (dir) => ({ CARGO_TARGET_DIR: join(dir, 'shared-target') }),
  });
  assert.deepEqual(
    shared.calls,
    [defaultBuildArgs(shared.targetRoot)],
    'under $CARGO_TARGET_DIR: exactly this one cargo command',
  );
  assertDefinitionClean(shared, 'under $CARGO_TARGET_DIR', DEFAULT_BUILD);
});

test('module-definition refuses a default build whose definition declares an HTTP handler, route or row filter (lpw-34.6)', () => {
  for (const [label, def, named] of DECLARING_DEFINITIONS) {
    const run = runJust(['module-definition'], { wasm: DEFAULT_BUILD, def });
    assertDefinitionRefused(run, label, named);
  }
});

test('module-definition refuses when the definition cannot be read or the build fails (lpw-34.6)', () => {
  for (const [label, options] of UNREADABLE_DEFINITIONS) {
    const run = runJust(['module-definition'], { wasm: DEFAULT_BUILD, ...options });
    assertDefinitionRefused(run, label);
    assert.deepEqual(run.pathExtractions, [], `${label}: no extractor found on PATH runs`);
  }

  // A failing cargo, over the artefact an earlier default build left: no definition is read.
  const failed = runJust(['module-definition'], {
    wasm: DEFAULT_BUILD,
    cargoExit: 101,
    leftover: DEFAULT_BUILD,
  });
  assert.equal(failed.calls.length, 1, 'a failing cargo: the build ran');
  assert.notEqual(failed.status, 0, 'a failing cargo fails the recipe');
  assert.deepEqual(failed.extractions, [], 'a failing cargo: no definition is read');
  assert.deepEqual(failed.pathExtractions, [], 'a failing cargo: no extractor on PATH runs');
});

test('just ci runs module-definition (lpw-34.6)', () => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('JUST_')) env[k] = v;
  }
  const result = spawnSync('just', ['--justfile', JUSTFILE, '--dump', '--dump-format', 'json'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  if (result.error) {
    throw new Error(`could not run \`just\`: ${result.error.message}`);
  }
  assert.equal(result.status, 0, `just --dump failed: ${result.stderr}`);
  const ci = JSON.parse(result.stdout).recipes.ci;
  assert.ok(ci, 'the justfile has a ci recipe');
  const dependencies = ci.dependencies.map((d) => d.recipe);
  assert.deepEqual(
    dependencies.filter((name) => name === 'module-definition'),
    ['module-definition'],
    `ci lists module-definition among its dependencies, once: ${JSON.stringify(dependencies)}`,
  );
});

test('module-profile prints the mr_build_profile section bytes exactly and runs no cargo', () => {
  for (const [label, sectionText] of [
    ['official', OFFICIAL_TEXT],
    ['world', WORLD_TEXT],
    ['test', 'profile=test\nenforces_ownership=false\ndev_reducers=true\n'],
  ]) {
    const artefact = wasmOf(profileSection(sectionText));
    const run = runJust(({ fixture }) => ['module-profile', fixture], { wasm: artefact });
    assert.equal(run.status, 0, `${label}: ${run.stderr}`);
    assert.equal(run.stdout, sectionText, `${label}: stdout is the section, byte for byte`);
    assert.deepEqual(run.calls, [], `${label}: no cargo`);
  }
});

test('module-profile refuses an artefact with no profile section or with two', () => {
  for (const [label, artefact] of [
    ['none', wasmOf()],
    ['two', wasmOf(profileSection(OFFICIAL_TEXT), profileSection(WORLD_TEXT))],
  ]) {
    const run = runJust(({ fixture }) => ['module-profile', fixture], { wasm: artefact });
    assert.notEqual(run.status, 0, `${label}: refused`);
    assert.ok(run.stderr.trim().length > 0, `${label}: a line on stderr`);
  }
});
