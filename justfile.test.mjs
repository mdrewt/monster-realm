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
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
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
// variables it was handed.
// ---------------------------------------------------------------------------

const RUSTFLAGS_VARS = [
  'RUSTFLAGS',
  'CARGO_BUILD_RUSTFLAGS',
  'CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS',
  'CARGO_ENCODED_RUSTFLAGS',
];

const CARGO_STAND_IN = [
  '#!/bin/sh',
  'for a in "$@"; do printf \'%s\\t\' "$a" >> "$MR_FAKE_CARGO_LOG"; done',
  'printf \'\\n\' >> "$MR_FAKE_CARGO_LOG"',
  ...RUSTFLAGS_VARS.map(
    (v) =>
      `if [ -n "\${${v}+x}" ]; then printf '%s\\tset\\t%s\\n' ${v} "$${v}" >> "$MR_FAKE_CARGO_ENV"; ` +
      `else printf '%s\\tunset\\n' ${v} >> "$MR_FAKE_CARGO_ENV"; fi`,
  ),
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

// Run `just <args>` from a fresh temp dir with the cargo stand-in first on PATH. `wasm` is what
// the stand-in builds; `env(dir)` adds variables; `preseed` writes a good artefact where the build
// would land before the recipe runs. Returns everything the assertions need, read before the
// temp dir is removed.
function runJust(
  args,
  { wasm = null, cargoExit = 0, env: extra = () => ({}), preseed = null } = {},
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'acs6-just-')));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const fake = join(bin, 'cargo');
    writeFileSync(fake, CARGO_STAND_IN);
    chmodSync(fake, 0o755);
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
    const log = join(dir, 'cargo.log');
    const envLog = join(dir, 'cargo.env');
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('JUST_') || k === 'CARGO_TARGET_DIR' || RUSTFLAGS_VARS.includes(k)) continue;
      env[k] = v;
    }
    Object.assign(
      env,
      {
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        MR_FAKE_CARGO_LOG: log,
        MR_FAKE_CARGO_ENV: envLog,
        MR_FAKE_CARGO_EXIT: String(cargoExit),
        MR_FAKE_WASM: fixture,
      },
      extra(dir),
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
    const calls = existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => line.split('\t').slice(0, -1))
      : [];
    const flags = existsSync(envLog)
      ? readFileSync(envLog, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => line.split('\t'))
      : [];
    const outputsUnder = (root, profile) => {
      const copy = join(root, 'release-module', `monster-realm-${profile}.wasm`);
      const sum = `${copy}.sha256`;
      return {
        copyPath: copy,
        copy: existsSync(copy) ? readFileSync(copy) : null,
        sum: existsSync(sum) ? readFileSync(sum, 'utf8') : null,
      };
    };
    const extraEnv = extra(dir);
    const targetRoot = extraEnv.CARGO_TARGET_DIR ?? join(dir, 'target');
    return {
      dir,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls,
      flags,
      targetRoot,
      outputs: {
        official: outputsUnder(targetRoot, 'official'),
        world: outputsUnder(targetRoot, 'world'),
      },
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

for (const profile of ['official', 'world']) {
  test(`release-module ${profile} runs one cargo build, the feature alone, compiler flags cleared whatever the caller exported`, () => {
    const run = runJust(['release-module', profile], {
      wasm: GOOD[profile],
      env: () => ({ ...EXPORTED_FLAGS }),
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.calls, [buildArgs(profile, 'target')], 'exactly this one cargo command');
    assert.deepEqual(run.flags, CLEARED_FLAGS, 'the compiler-flag variables cargo was handed');
  });
}

test('release-module official sets CARGO_ENCODED_RUSTFLAGS empty when the caller exported nothing', () => {
  const run = runJust(['release-module', 'official'], { wasm: GOOD.official });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.calls, [buildArgs('official', 'target')]);
  assert.deepEqual(run.flags, CLEARED_FLAGS);
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
