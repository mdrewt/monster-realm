// validate.test.mjs — lp-05 gating suite (TDD RED) for the Tier-2 observability validator.
//
// Encodes the three EARS criteria of M-loop-infrastructure §lp-05 and the three
// fail-closed directions of ADR-0201:
//
//   EARS-1  WHEN the observability config changes, THE SYSTEM SHALL run the Tier-2
//           validator.                          → §E (wiring: justfile ci: dep + ci.yml step)
//   EARS-2  WHEN --require-docker is passed and docker is unavailable, THE SYSTEM SHALL
//           FAIL rather than skip.              → §A (summarize rule 3) + §C (subprocess)
//   EARS-3  WHEN docker is unavailable and the flag is absent, THE SYSTEM SHALL report
//           `skipped` loudly and exit 0.        → §A + §C
//
// CONTRACT this suite pins (the implementer adds these to ./validate.mjs, keeping all
// current behaviour):
//
//   export const IMAGES = { prometheus, alloy, loki, tempo };        // already exists, exported
//   export const EXPECTED_MIN_CHECKS = Object.keys(IMAGES).length + 3;
//   export function summarize(results, { requireDocker = false } = {})
//       -> { exitCode: 0|1, failed: number, skipped: number, reason: string }
//   export function main(argv) -> 0 | 1 | 64      // returns, never calls process.exit
//   if (import.meta.main) process.exit(main(process.argv.slice(2)));
//
//   summarize rules, applied IN THIS ORDER:
//     1. status allowlist — anything not exactly 'pass'|'fail'|'skipped' → exitCode 1
//     2. any 'fail'                                                     → exitCode 1
//     3. any 'skipped' while requireDocker                              → exitCode 1, reason names it
//     4. no skips and results.length < EXPECTED_MIN_CHECKS              → exitCode 1 (non-vacuity)
//     5. otherwise                                                      → exitCode 0
//
// THE THREE CHEATS THIS SUITE EXISTS TO KILL (all three passed an earlier 24/24 suite):
//   C1 "n/a"      — run only `docker compose config`, give the other six results status:'n/a'.
//                   Killed by: §A status-allowlist tests, §D3 (config filenames), §D4 (count floor).
//   C2 "pass"     — same shrink but label the six phantom results status:'pass'.
//                   Killed by: §D2/§D3/§D4 — the argv RECORDING proves docker was really invoked
//                   with the real images and the real config paths; a phantom 'pass' records nothing.
//   C3 "busybox"  — keep all eight checks but point every image at busybox:latest and every
//                   config path at /dev/null.
//                   Killed by: §A3 (every IMAGES value must appear verbatim in the committed
//                   docker-compose.yml) + §D2/§D3.
//
// HARD RULES honoured here (CI-enforced):
//   - NO `new RegExp(...)` anywhere — literal regex literals and String methods only
//     (Semgrep detect-non-literal-regexp has bitten this repo 3×).
//   - Real files are resolved from `import.meta.dirname`, never `process.cwd()`.
//   - No conditional skips: no platform guards, no "skip if docker absent". Every test runs
//     everywhere — docker is never REQUIRED, it is either scrubbed off PATH or replaced by a
//     recorded shim.
//   - Subprocesses spawn `process.execPath`, never the bare string 'node': with PATH scrubbed,
//     'node' fails ENOENT and a `notEqual(status, 0)` assertion would pass VACUOUSLY without the
//     validator ever running.
//   - PATH is scrubbed by pointing it at a fresh EMPTY directory. `delete env.PATH` and `env: {}`
//     do NOT hide docker — measured: libuv falls back to the confstr(_CS_PATH) default
//     `/bin:/usr/bin` and still finds it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// ---------------------------------------------------------------------------
// Temp-dir bookkeeping (every dir created here is removed in the `after` hook).
// ---------------------------------------------------------------------------
const TEMP_DIRS = [];

function makeTempDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

after(() => {
  for (const dir of TEMP_DIRS) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Guarded load of the module under test.
//
// TODAY (RED) ./validate.mjs has no entry guard: importing it runs the whole body and
// calls process.exit(). Under `node --test` that would terminate the file's child
// process BEFORE a single test is registered — a zero-test file exits 0, i.e. a VACUOUS
// GREEN. So the import happens with PATH scrubbed (docker invisible → the fast
// skip path) and with process.exit patched to THROW. The rejection is captured and
// asserted on by the first test, which fails loudly and by name.
//
// Once the `import.meta.main` guard lands this whole block is inert.
// ---------------------------------------------------------------------------
const IMPORT_GUARD_DIR = makeTempDir('mr-validate-import-guard-');
const savedPath = process.env.PATH;
const savedExit = process.exit;
const savedLog = console.log;
let importError = null;
let mod = {};
try {
  process.env.PATH = IMPORT_GUARD_DIR;
  process.exit = (code) => {
    throw new Error(
      `validate.mjs called process.exit(${code}) while being IMPORTED — the module still runs its ` +
        'body at import time. It needs the `if (import.meta.main) process.exit(main(...))` entry guard.',
    );
  };
  console.log = () => {};
  mod = await import('./validate.mjs');
} catch (err) {
  importError = err;
} finally {
  console.log = savedLog;
  process.exit = savedExit;
  process.env.PATH = savedPath;
}

const { EXPECTED_MIN_CHECKS, IMAGES, main, summarize } = mod;

// ---------------------------------------------------------------------------
// Real-file paths (resolved from import.meta.dirname, never process.cwd()).
// ---------------------------------------------------------------------------
const OPS_DIR = import.meta.dirname;
const REPO_ROOT = path.join(import.meta.dirname, '..', '..');
const VALIDATE_PATH = path.join(OPS_DIR, 'validate.mjs');
const COMPOSE_PATH = path.join(OPS_DIR, 'docker-compose.yml');
const JUSTFILE_PATH = path.join(REPO_ROOT, 'justfile');
const CI_YML_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

function readReal(filePath) {
  return readFileSync(filePath, 'utf8');
}

// ---------------------------------------------------------------------------
// summarize helpers
// ---------------------------------------------------------------------------
function assertSummaryShape(summary, context) {
  assert.ok(
    summary !== null && typeof summary === 'object',
    `${context}: summarize must return an object`,
  );
  assert.equal(typeof summary.exitCode, 'number', `${context}: exitCode must be a number`);
  assert.equal(typeof summary.failed, 'number', `${context}: failed must be a number`);
  assert.equal(typeof summary.skipped, 'number', `${context}: skipped must be a number`);
  assert.equal(typeof summary.reason, 'string', `${context}: reason must be a string`);
  if (summary.exitCode !== 0) {
    assert.ok(summary.reason.length > 0, `${context}: a non-zero exitCode must carry a reason`);
  }
}

/** n synthetic all-`pass` results — built from EXPECTED_MIN_CHECKS, never a hardcoded 7/8. */
function passResults(n) {
  return Array.from({ length: n }, (_, i) => ({
    label: `synthetic check ${i + 1}`,
    status: 'pass',
    detail: 'ok',
  }));
}

const SKIP_RESULT = {
  label: 'all tool-backed checks',
  status: 'skipped',
  detail: 'docker is not available — Tier-2 validation did NOT run (this is not a pass)',
};

// =============================================================================
// §A — pure summarize / export-contract tests
// =============================================================================

test('§A1 the module exports the contracted API and does NOT run its body on import', () => {
  assert.equal(
    importError,
    null,
    `importing ./validate.mjs failed: ${importError ? importError.message : ''}`,
  );
  assert.equal(typeof summarize, 'function', 'validate.mjs must export function summarize()');
  assert.equal(typeof main, 'function', 'validate.mjs must export function main(argv)');
  assert.ok(IMAGES !== null && typeof IMAGES === 'object', 'validate.mjs must export IMAGES');
  assert.equal(
    typeof EXPECTED_MIN_CHECKS,
    'number',
    'validate.mjs must export EXPECTED_MIN_CHECKS',
  );
});

test('§A2 EXPECTED_MIN_CHECKS is DERIVED from IMAGES (Object.keys(IMAGES).length + 3), not hand-typed', () => {
  const imageCount = Object.keys(IMAGES).length;
  assert.ok(imageCount >= 4, `IMAGES must still hold the 4 pinned stack images, got ${imageCount}`);
  assert.equal(
    EXPECTED_MIN_CHECKS,
    imageCount + 3,
    'EXPECTED_MIN_CHECKS must be Object.keys(IMAGES).length + 3 — a second hand-maintained ' +
      'constant is exactly the thing that silently drifts down as checks are deleted',
  );
});

test('§A3 every IMAGES value is the digest-pinned image the committed compose file deploys (kills the busybox:latest cheat)', () => {
  const compose = readReal(COMPOSE_PATH);
  for (const [service, image] of Object.entries(IMAGES)) {
    assert.equal(typeof image, 'string', `IMAGES.${service} must be a string`);
    assert.ok(
      image.indexOf('@sha256:') !== -1,
      `IMAGES.${service} must be digest-pinned, got '${image}'`,
    );
    assert.ok(
      compose.indexOf(image) !== -1,
      `IMAGES.${service} = '${image}' does not appear verbatim in ops/observability/docker-compose.yml — ` +
        'the validator must run the EXACT image the stack deploys; repointing it at busybox:latest ' +
        'keeps all eight checks green while validating nothing',
    );
  }
});

// --- Rule 1: the status allowlist (fail-closed). Each fixture is padded with
// EXPECTED_MIN_CHECKS passing results so the non-vacuity floor (rule 4) can NOT be what
// reds it — the ONLY thing that can fail these is the allowlist itself.
const BAD_STATUSES = [
  {
    name: "'Skipped' (capital S — the printer's .toUpperCase() makes the log read SKIPPED while the process exits 0)",
    status: 'Skipped',
  },
  { name: "'SKIPPED' (already upper-cased)", status: 'SKIPPED' },
  { name: "'skip' (truncated)", status: 'skip' },
  { name: "'failed' (past tense — a blacklist on 'fail' misses it)", status: 'failed' },
  { name: "'error'", status: 'error' },
  { name: 'undefined (a result object with no status key at all)', status: undefined },
];

for (const bad of BAD_STATUSES) {
  test(`§A4 summarize rule 1 (fail-closed allowlist): status ${bad.name} → exitCode 1`, () => {
    const results = [
      ...passResults(EXPECTED_MIN_CHECKS),
      { label: 'unknown-status check', status: bad.status, detail: 'x' },
    ];
    for (const requireDocker of [true, false]) {
      const summary = summarize(results, { requireDocker });
      const context = `status=${String(bad.status)} requireDocker=${requireDocker}`;
      assertSummaryShape(summary, context);
      assert.equal(
        summary.exitCode,
        1,
        `${context}: a status outside {pass,fail,skipped} must FAIL the run. The rules are an ` +
          'ALLOWLIST, not a blacklist — every one of these six shapes exited 0 in the red-team pass.',
      );
    }
  });
}

test('§A5 summarize rule 2: any fail result → exitCode 1 (and failed counts it)', () => {
  const results = [
    ...passResults(EXPECTED_MIN_CHECKS - 1),
    { label: 'promtool check config', status: 'fail', detail: 'boom' },
  ];
  const summary = summarize(results, { requireDocker: false });
  assertSummaryShape(summary, 'one fail');
  assert.equal(summary.exitCode, 1, 'a failing check must exit 1 even without --require-docker');
  assert.equal(summary.failed, 1, 'failed must count the failing result');
});

test('§A6 summarize rule 3 (EARS-2): a skipped result with requireDocker:true → exitCode 1, reason names the label', () => {
  const summary = summarize([SKIP_RESULT], { requireDocker: true });
  assertSummaryShape(summary, 'skipped + requireDocker');
  assert.equal(
    summary.exitCode,
    1,
    'EARS-2: under --require-docker a skip is a FAILURE — a gate that reports skipped and exits 0 ' +
      'is a gate that passes while checking nothing',
  );
  assert.equal(summary.skipped, 1, 'skipped must count the skipped result');
  assert.ok(
    summary.reason.indexOf(SKIP_RESULT.label) !== -1,
    `reason must name the skipped label '${SKIP_RESULT.label}', got: ${summary.reason}`,
  );
});

test('§A7 summarize rule 3 inverted (EARS-3): the SAME skipped result with requireDocker:false → exitCode 0', () => {
  const summary = summarize([SKIP_RESULT], { requireDocker: false });
  assertSummaryShape(summary, 'skipped without the flag');
  assert.equal(
    summary.exitCode,
    0,
    'EARS-3: without the flag a skip is loud but not fatal — the laptop path must keep working',
  );
  assert.equal(summary.skipped, 1, 'the skip is still COUNTED, just not fatal');
  assert.equal(summary.failed, 0, 'a skip is not a failure');
});

test('§A8 summarize rule 4: an empty results array → exitCode 1 (scanning nothing is never green)', () => {
  const withOptions = summarize([], { requireDocker: false });
  assertSummaryShape(withOptions, 'empty results');
  assert.equal(withOptions.exitCode, 1, 'zero checks must never read as a pass');

  // Also exercise the documented default parameter — summarize(results) with no options.
  const withDefaults = summarize([]);
  assertSummaryShape(withDefaults, 'empty results, default options');
  assert.equal(
    withDefaults.exitCode,
    1,
    'summarize(results) with the default options object must still apply the non-vacuity floor',
  );
});

test('§A9 summarize rule 4: EXPECTED_MIN_CHECKS - 1 all-pass results, no skips → exitCode 1 (the shrink floor)', () => {
  const summary = summarize(passResults(EXPECTED_MIN_CHECKS - 1), { requireDocker: true });
  assertSummaryShape(summary, 'below the floor');
  assert.equal(
    summary.exitCode,
    1,
    `fewer than EXPECTED_MIN_CHECKS (${EXPECTED_MIN_CHECKS}) results with no skips means the check ` +
      'set shrank — this is the floor that stops "delete six checks, keep one green one"',
  );
});

test('§A10 summarize rule 5: exactly EXPECTED_MIN_CHECKS all-pass results, no skips → exitCode 0', () => {
  const summary = summarize(passResults(EXPECTED_MIN_CHECKS), { requireDocker: true });
  assertSummaryShape(summary, 'at the floor');
  assert.equal(
    summary.exitCode,
    0,
    'a full, all-passing check set must pass — without this positive control an implementation ' +
      'that always returns 1 would satisfy every negative test above',
  );
  assert.equal(summary.failed, 0, 'failed must be 0');
  assert.equal(summary.skipped, 0, 'skipped must be 0');
});

// =============================================================================
// §B — main(argv) argument handling, in-process.
//
// Only the REJECTED shapes are exercised in-process: they must return 64 BEFORE any
// docker invocation, so running them costs nothing. The accepted shapes (`[]` and
// `['--require-docker']`) would run the full image gauntlet in-process, so they are
// covered by the subprocess tests in §C/§D instead.
// =============================================================================

const BAD_ARGVS = [
  { name: "['-r'] — a short alias nobody defined", argv: ['-r'] },
  {
    name: "['--require-docker=false'] — the =value form must not silently disable the gate",
    argv: ['--require-docker=false'],
  },
  { name: "['--nope'] — an unknown flag", argv: ['--nope'] },
  { name: "['positional'] — a stray positional argument", argv: ['positional'] },
  {
    name: "['--require-docker','extra'] — the right flag plus a trailing argument",
    argv: ['--require-docker', 'extra'],
  },
];

for (const bad of BAD_ARGVS) {
  test(`§B1 main(argv) rejects ${bad.name} with exit code 64`, () => {
    const code = main(bad.argv);
    assert.equal(
      code,
      64,
      'unrecognised argv must return EX_USAGE (64) — not 0 (which would make a typo in the ' +
        'justfile recipe a silent no-op gate) and not 1 (indistinguishable from a real failure)',
    );
  });
}

test('§B2 main([]) and main([--require-docker]) are ACCEPTED shapes — they must not return 64', () => {
  // Proven without executing docker: these two argv forms are the only accepted ones, so the
  // usage path must not claim them. The real end-to-end behaviour of both is asserted in §C/§D.
  const scrubDir = makeTempDir('mr-validate-argv-accept-');
  for (const argv of [[], ['--require-docker']]) {
    const res = spawnSync(process.execPath, [VALIDATE_PATH, ...argv], {
      cwd: REPO_ROOT,
      env: { ...process.env, PATH: scrubDir },
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.notEqual(
      res.status,
      64,
      `\`node validate.mjs ${argv.join(' ')}\` must be an ACCEPTED argv shape, but it exited 64 ` +
        `(usage). stdout: ${res.stdout} stderr: ${res.stderr}`,
    );
  }
});

test('§B3 the usage message for a rejected argv goes to STDERR, not stdout', () => {
  const out = [];
  const err = [];
  const realLog = console.log;
  const realError = console.error;
  let code;
  try {
    console.log = (...args) => out.push(args.join(' '));
    console.error = (...args) => err.push(args.join(' '));
    code = main(['--nope']);
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  assert.equal(code, 64, 'rejected argv still returns 64');
  assert.ok(
    err.join('\n').length > 0,
    'a usage message must be written to stderr — a gate that rejects its own invocation silently ' +
      'is indistinguishable from one that ran',
  );
  assert.equal(
    out.join('\n'),
    '',
    'usage must NOT go to stdout: log scrapers and `| tail` reads treat stdout as the report',
  );
});

// =============================================================================
// §C — subprocess behaviour with docker genuinely unavailable (PATH → empty dir).
// =============================================================================

function runValidator(argv, env) {
  const res = spawnSync(process.execPath, [VALIDATE_PATH, ...argv], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  });
  return {
    status: res.status,
    output: `${res.stdout ?? ''}\n${res.stderr ?? ''}`,
  };
}

test('§C1 EARS-2: --require-docker with docker absent → exit code exactly 1, and the output never says SKIPPED', () => {
  const scrubDir = makeTempDir('mr-validate-nodocker-strict-');
  const { status, output } = runValidator(['--require-docker'], {
    ...process.env,
    PATH: scrubDir,
  });
  assert.equal(
    status,
    1,
    `EARS-2: docker unavailable under --require-docker must exit 1 exactly. Got ${status}. Output:\n${output}`,
  );
  assert.equal(
    output.indexOf('SKIPPED'),
    -1,
    `EARS-2: the strict run must not print SKIPPED anywhere — "validate SKIPPED: …" next to a ` +
      `failing exit code is the exact false-comfort line this slice exists to remove. Output:\n${output}`,
  );
  assert.ok(
    output.indexOf('docker') !== -1,
    `the failure must say docker was unavailable. Output:\n${output}`,
  );
  assert.ok(
    output.indexOf('--require-docker') !== -1,
    `the failure must name the flag that made it fatal, so the reader knows the lax path exists. Output:\n${output}`,
  );
});

test('§C2 EARS-3: no flag with docker absent → exit code exactly 0, output says SKIPPED and "this is not a pass"', () => {
  const scrubDir = makeTempDir('mr-validate-nodocker-lax-');
  const { status, output } = runValidator([], { ...process.env, PATH: scrubDir });
  assert.equal(
    status,
    0,
    `EARS-3: the laptop path (no flag, no docker) must still exit 0. Got ${status}. Output:\n${output}`,
  );
  assert.ok(
    output.indexOf('SKIPPED') !== -1,
    `EARS-3: the skip must be LOUD — the word SKIPPED must appear. Output:\n${output}`,
  );
  assert.ok(
    output.indexOf('this is not a pass') !== -1,
    `EARS-3: the existing "(this is not a pass)" phrasing must survive — a skip and a pass are ` +
      `different words here on purpose. Output:\n${output}`,
  );
});

// =============================================================================
// §D — the killer tooth: an argv-RECORDING `docker` shim.
//
// A `#!/bin/sh` script named `docker` appends its whole argv to a log and exits 0
// (printing something version-shaped for `docker version` so hasDocker() succeeds).
// The assertions are on the RECORDED INVOCATIONS, so an implementation that fabricates
// result objects records nothing and dies here.
// =============================================================================

const SHIM_VERSION_OUTPUT = '27.0.0';

function makeDockerShim(kind) {
  const dir = makeTempDir(`mr-validate-shim-${kind}-`);
  const logPath = path.join(dir, 'invocations.log');
  const failClause =
    kind === 'failcompose'
      ? ['case "$*" in', '  *compose*config*) exit 1 ;;', 'esac', ''].join('\n')
      : '';
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> '${logPath}'`,
    'if [ "$1" = version ]; then',
    `  echo ${SHIM_VERSION_OUTPUT}`,
    '  exit 0',
    'fi',
    '',
    failClause,
    'exit 0',
    '',
  ].join('\n');
  const shimPath = path.join(dir, 'docker');
  writeFileSync(shimPath, script, { mode: 0o755 });
  chmodSync(shimPath, 0o755);
  return { dir, logPath };
}

function readInvocations(logPath) {
  let text = '';
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    text = '';
  }
  return text.split('\n').filter((line) => line.trim().length > 0);
}

// One spawn, memoised, shared by §D1..§D4 (the shim is deterministic and side-effect free).
let recordedRun = null;
function runUnderRecordingShim() {
  if (recordedRun === null) {
    const { dir, logPath } = makeDockerShim('ok');
    const { status, output } = runValidator(['--require-docker'], { ...process.env, PATH: dir });
    recordedRun = { status, output, invocations: readInvocations(logPath) };
  }
  return recordedRun;
}

test('§D1 positive control: with an all-succeeding docker shim the validator exits 0', () => {
  const { status, output } = runUnderRecordingShim();
  assert.equal(
    status,
    0,
    `an implementation whose checks all succeed must exit 0 — without this positive control an ` +
      `always-failing implementation would satisfy every negative assertion. Output:\n${output}`,
  );
});

test('§D2 every pinned image in IMAGES is actually handed to docker (kills the phantom-pass and busybox cheats)', () => {
  const { invocations, output } = runUnderRecordingShim();
  const joined = invocations.join('\n');
  for (const [service, image] of Object.entries(IMAGES)) {
    assert.ok(
      joined.indexOf(image) !== -1,
      `no recorded docker invocation mentions IMAGES.${service} ('${image}'). A result object ` +
        `labelled 'pass' that never invoked docker records nothing here. Recorded ` +
        `${invocations.length} invocation(s):\n${joined}\n---\nValidator output:\n${output}`,
    );
  }
});

const COMMITTED_CONFIG_FILES = [
  'docker-compose.yml',
  'prometheus.yml',
  'rules/recording.rules.yml',
  'alloy/config.alloy',
  'loki/loki-config.yml',
  'tempo/tempo-config.yml',
  'Caddyfile',
];

for (const configFile of COMMITTED_CONFIG_FILES) {
  test(`§D3 the committed config '${configFile}' is named in a real docker invocation`, () => {
    const { invocations, output } = runUnderRecordingShim();
    const joined = invocations.join('\n');
    assert.ok(
      joined.indexOf(configFile) !== -1,
      `no recorded docker invocation names '${configFile}'. Pointing a check at /dev/null, or ` +
        `deleting the check and fabricating its result, both look like this. Recorded ` +
        `${invocations.length} invocation(s):\n${joined}\n---\nValidator output:\n${output}`,
    );
  });
}

test('§D4 the number of real docker invocations is at least EXPECTED_MIN_CHECKS (the check set did not shrink)', () => {
  const { invocations } = runUnderRecordingShim();
  assert.ok(
    invocations.length >= EXPECTED_MIN_CHECKS,
    `only ${invocations.length} docker invocation(s) were recorded, below the ` +
      `EXPECTED_MIN_CHECKS floor of ${EXPECTED_MIN_CHECKS}:\n${invocations.join('\n')}`,
  );
});

test('§D5 a rejected argv shape returns 64 WITHOUT invoking docker even once', () => {
  const { dir, logPath } = makeDockerShim('ok');
  const { status, output } = runValidator(['--nope'], { ...process.env, PATH: dir });
  assert.equal(status, 64, `an unknown flag must exit 64. Output:\n${output}`);
  assert.deepEqual(
    readInvocations(logPath),
    [],
    'argv validation must happen BEFORE any docker work — a validator that pulls 1.6 GB of ' +
      'images and only then complains about its own flags is not argv validation',
  );
});

test('§D6 negative control: a real check failure propagates — `docker compose config` fails → exit 1 and the check is named', () => {
  const { dir } = makeDockerShim('failcompose');
  const { status, output } = runValidator(['--require-docker'], { ...process.env, PATH: dir });
  assert.equal(
    status,
    1,
    `a failing \`docker compose config\` must red the run. Got ${status}. Output:\n${output}`,
  );
  assert.ok(
    output.indexOf('docker compose config') !== -1,
    `the output must name the failing check by its label. Output:\n${output}`,
  );
  assert.ok(
    output.indexOf('FAIL') !== -1,
    `the output must mark the check FAIL, not merely list it. Output:\n${output}`,
  );
});

// =============================================================================
// §E — wiring (EARS-1). Every predicate gets known-bad inline fixtures FIRST
// (repo convention), then runs against the REAL committed justfile / ci.yml.
//
// Every assertion is SCOPED to the right recipe body or job block: an unscoped exact-line
// match is defeated by parking the literal line in a dead recipe (measured).
// =============================================================================

const VALIDATE_RECIPE = 'observability-validate';
const EXPECTED_RECIPE_LINE = 'node ops/observability/validate.mjs --require-docker';
const EXPECTED_CI_STEP = '- run: just observability-validate';
const TEST_SUITE_TOKEN = 'ops/observability/validate.test.mjs';

// --- justfile extractors -----------------------------------------------------

/** The dep list on a recipe's HEADER line (column 0, non-comment). null if no such recipe. */
function recipeHeaderDeps(justfileText, recipeName) {
  for (const line of justfileText.split('\n')) {
    if (line.length === 0) continue;
    if (line[0] === ' ' || line[0] === '\t') continue; // recipe headers sit at column 0
    if (line.trim().startsWith('#')) continue;
    if (!line.startsWith(`${recipeName}:`) && !line.startsWith(`${recipeName} `)) continue;
    const colon = line.indexOf(':');
    if (colon === -1) return [];
    return line
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }
  return null;
}

/** A recipe's COMMENT-STRIPPED command lines, trimmed. null if no such recipe. */
function recipeCommandLines(justfileText, recipeName) {
  const lines = justfileText.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    if (line[0] === ' ' || line[0] === '\t') continue;
    if (line.trim().startsWith('#')) continue;
    if (line.startsWith(`${recipeName}:`) || line.startsWith(`${recipeName} `)) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue; // blank lines may sit inside a body
    if (line[0] !== ' ' && line[0] !== '\t') break; // a dedent ends the recipe
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue; // comments are not commands
    body.push(trimmed);
  }
  return body;
}

/** { ok, reason } — the recipe body is EXACTLY the one expected command line and nothing else. */
function recipeBodyIsExactly(justfileText, recipeName, expectedLine) {
  const body = recipeCommandLines(justfileText, recipeName);
  if (body === null) {
    return { ok: false, reason: `justfile has no \`${recipeName}:\` recipe at column 0` };
  }
  if (body.length === 0) {
    return { ok: false, reason: `\`${recipeName}:\` has an empty body — a gate that runs nothing` };
  }
  if (body.length !== 1) {
    return {
      ok: false,
      reason: `\`${recipeName}:\` must have exactly ONE command line, found ${body.length}: ${JSON.stringify(body)}`,
    };
  }
  if (body[0] !== expectedLine) {
    return {
      ok: false,
      reason:
        `\`${recipeName}:\` body must be exactly '${expectedLine}', got '${body[0]}' — exact ` +
        "equality rejects just's `-` (ignore-error) and `@` (quiet) prefixes as well as " +
        '`|| true`, `; exit 0` and `&& …` suffixes',
    };
  }
  return { ok: true, reason: 'exact' };
}

// --- ci.yml extractors (the evals/e2e-desync-teeth + ci-gate-wiring idioms) ---

function extractJobBlock(yaml, jobName) {
  const lines = yaml.split('\n');
  const keyLine = `  ${jobName}:`;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === keyLine || lines[i].startsWith(`${keyLine} `)) {
      start = i;
      break;
    }
  }
  if (start === -1) return '';
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      block.push(line);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break; // a top-level key ends the block
    if (indent === 2) break; // the next job key ends the block
    block.push(line);
  }
  return `${block.join('\n')}\n`;
}

/** { ok, reason } — the named job block holds a non-comment line trimming to EXACTLY exactStep. */
function jobHasExactStep(yaml, jobName, exactStep) {
  const block = extractJobBlock(yaml, jobName);
  if (block.trim() === '') {
    return { ok: false, reason: `ci.yml has no \`${jobName}:\` job block (no vacuous pass)` };
  }
  const found = block.split('\n').some((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith('#') && trimmed === exactStep;
  });
  if (!found) {
    return {
      ok: false,
      reason:
        `the \`${jobName}:\` job has no non-comment line trimming to exactly '${exactStep}' — ` +
        'a commented-out step, a suffixed one (`|| true`), a `run: |` block, or the step living ' +
        'in a different job all look like this',
    };
  }
  return { ok: true, reason: 'exact step present' };
}

// Truthy `continue-on-error:` forms (mirrors ci-gate-wiring's isTruthyCoe).
function isTruthyCoe(value) {
  return /^(true|yes|on|True)\b/.test(value) || /\$\{\{\s*true\s*\}\}/.test(value);
}

/**
 * The [start, end) line range of the step containing `exactStep`, or null.
 * A step begins at a 6-space-indented `- ` item (standard GitHub Actions indent).
 */
function findStepRange(lines, exactStep) {
  const STEP_PREFIX = '      - ';
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('#') || trimmed !== exactStep) continue;
    let stepStart = i;
    while (stepStart > 0 && !lines[stepStart].startsWith(STEP_PREFIX)) stepStart--;
    let stepEnd = i + 1;
    while (stepEnd < lines.length) {
      const line = lines[stepEnd];
      if (line.trim() === '') {
        stepEnd++;
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent <= 6 && line.trimStart().startsWith('- ')) break;
      if (indent <= 4 && !line.trimStart().startsWith('- ')) break;
      stepEnd++;
    }
    return [stepStart, stepEnd];
  }
  return null;
}

/**
 * { ok, reason } — within the step's own line range there is no `if:` and no truthy
 * `continue-on-error:`.
 *
 * WHY this predicate has to exist here: evals/ci-gate-wiring.eval.mjs::ciStepsUnneutered
 * inspects step ranges ONLY for its seven hardcoded REQUIRED_JUST_STEPS, so this new step is
 * otherwise completely unprotected. This assertion is that gap's only cover.
 */
function stepIsUnneutered(yaml, exactStep) {
  const lines = yaml.split('\n');
  const range = findStepRange(lines, exactStep);
  if (range === null) {
    return { ok: false, reason: `no step whose trimmed form is exactly '${exactStep}'` };
  }
  const [start, end] = range;
  for (let i = start; i < end; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('if:')) {
      return {
        ok: false,
        reason: `step '${exactStep}' carries a step-level if: — the gate can be skipped silently`,
      };
    }
    if (trimmed.startsWith('continue-on-error:')) {
      const value = trimmed.slice('continue-on-error:'.length).trim();
      if (isTruthyCoe(value)) {
        return {
          ok: false,
          reason: `step '${exactStep}' carries a truthy continue-on-error: ${value} — the gate cannot fail`,
        };
      }
    }
  }
  return { ok: true, reason: 'step is unneutered' };
}

function countNonCommentMentions(text, token) {
  let count = 0;
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('#')) continue;
    if (line.indexOf(token) !== -1) count++;
  }
  return count;
}

// --- inline fixtures ---------------------------------------------------------

const GOOD_JUSTFILE = [
  'lint:',
  '    cargo fmt --all --check',
  '',
  'observability-validate:',
  `    ${EXPECTED_RECIPE_LINE}`,
  '',
  'test:',
  '    cargo nextest run --workspace',
  `    node --test ${TEST_SUITE_TOKEN}`,
  '',
  'ci: lint test observability-validate',
  '',
].join('\n');

const GOOD_CI_YAML = [
  'name: CI',
  'on:',
  '  pull_request:',
  'jobs:',
  '  ci:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: just lint',
  '      - run: just test',
  '      - run: just observability-validate',
  '  e2e:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: just e2e',
  '',
].join('\n');

// =============================================================================
// §E1 — the ci: recipe HEADER lists the dep
// =============================================================================

test('§E1 teeth: recipeHeaderDeps is scoped to the ci: header line — a comment or a dead recipe does not count', () => {
  assert.ok(
    recipeHeaderDeps(GOOD_JUSTFILE, 'ci').includes(VALIDATE_RECIPE),
    'known-good: the dep on the ci: header line must be seen',
  );

  const parkedInComment = GOOD_JUSTFILE.replace(
    'ci: lint test observability-validate',
    [
      '# ci: lint test observability-validate  (the real line below dropped it)',
      'ci: lint test',
    ].join('\n'),
  );
  assert.equal(
    recipeHeaderDeps(parkedInComment, 'ci').includes(VALIDATE_RECIPE),
    false,
    'known-bad: the dep named only in a `#` comment must NOT satisfy the gate',
  );

  const parkedInDeadRecipe = GOOD_JUSTFILE.replace(
    'ci: lint test observability-validate',
    ['dead-recipe:', '    just observability-validate', '', 'ci: lint test'].join('\n'),
  );
  assert.equal(
    recipeHeaderDeps(parkedInDeadRecipe, 'ci').includes(VALIDATE_RECIPE),
    false,
    'known-bad: the verb parked in a recipe nothing invokes must NOT satisfy the gate — this is ' +
      'the measured bypass an unscoped whole-file match falls to',
  );
});

test('§E2 EARS-1: the REAL justfile ci: recipe header lists observability-validate as a dep', () => {
  const justfileText = readReal(JUSTFILE_PATH);
  const deps = recipeHeaderDeps(justfileText, 'ci');
  assert.notEqual(deps, null, 'the justfile must still have a `ci:` recipe at column 0');
  assert.ok(
    deps.includes(VALIDATE_RECIPE),
    `EARS-1: \`ci:\` must depend on \`${VALIDATE_RECIPE}\`, got deps: ${JSON.stringify(deps)}. ` +
      'A ci: DEP (not a body line) is the placement evals/ci-gate-wiring.eval.mjs::' +
      'justfileCiDepsAppearInCi enforces against ci.yml — a body line is enforced by nothing.',
  );
});

// =============================================================================
// §E3/§E4 — the observability-validate recipe BODY
// =============================================================================

test('§E3 teeth: recipeBodyIsExactly rejects every neutering prefix/suffix and any extra command line', () => {
  assert.equal(
    recipeBodyIsExactly(GOOD_JUSTFILE, VALIDATE_RECIPE, EXPECTED_RECIPE_LINE).ok,
    true,
    'known-good: the plain one-line body must be accepted',
  );

  const badBodies = [
    { name: "just's `-` ignore-error prefix", line: `-${EXPECTED_RECIPE_LINE}` },
    { name: "just's `@` quiet prefix hiding the command", line: `@${EXPECTED_RECIPE_LINE}` },
    { name: '`|| true`', line: `${EXPECTED_RECIPE_LINE} || true` },
    { name: '`; exit 0`', line: `${EXPECTED_RECIPE_LINE} ; exit 0` },
    {
      name: '`&& echo ok` (a trailing conjunct changes the line)',
      line: `${EXPECTED_RECIPE_LINE} && echo ok`,
    },
    { name: 'the flag dropped entirely', line: 'node ops/observability/validate.mjs' },
    { name: 'the command only inside a comment', line: `# ${EXPECTED_RECIPE_LINE}` },
  ];
  for (const bad of badBodies) {
    const fixture = GOOD_JUSTFILE.replace(`    ${EXPECTED_RECIPE_LINE}`, `    ${bad.line}`);
    assert.equal(
      recipeBodyIsExactly(fixture, VALIDATE_RECIPE, EXPECTED_RECIPE_LINE).ok,
      false,
      `known-bad: a body of '${bad.line}' (${bad.name}) must be REJECTED`,
    );
  }

  const extraLine = GOOD_JUSTFILE.replace(
    `    ${EXPECTED_RECIPE_LINE}`,
    `    ${EXPECTED_RECIPE_LINE}\n    echo "done"`,
  );
  assert.equal(
    recipeBodyIsExactly(extraLine, VALIDATE_RECIPE, EXPECTED_RECIPE_LINE).ok,
    false,
    'known-bad: a second command line in the body must be REJECTED — the recipe is one invocation',
  );

  const parkedElsewhere = GOOD_JUSTFILE.replace(
    ['observability-validate:', `    ${EXPECTED_RECIPE_LINE}`].join('\n'),
    [
      'dead-recipe:',
      `    ${EXPECTED_RECIPE_LINE}`,
      '',
      'observability-validate:',
      '    echo "wired, honest"',
    ].join('\n'),
  );
  assert.equal(
    recipeBodyIsExactly(parkedElsewhere, VALIDATE_RECIPE, EXPECTED_RECIPE_LINE).ok,
    false,
    'known-bad: the exact line parked in a DIFFERENT recipe must not satisfy this one — scoping ' +
      'to the recipe body is the whole point',
  );
});

test('§E4 EARS-1: the REAL observability-validate recipe body is exactly the strict invocation', () => {
  const justfileText = readReal(JUSTFILE_PATH);
  const result = recipeBodyIsExactly(justfileText, VALIDATE_RECIPE, EXPECTED_RECIPE_LINE);
  assert.equal(
    result.ok,
    true,
    `EARS-1/EARS-2 wiring: ${result.reason}. The recipe must be exactly:\n` +
      `${VALIDATE_RECIPE}:\n    ${EXPECTED_RECIPE_LINE}`,
  );
});

// =============================================================================
// §E5..§E8 — the ci.yml step
// =============================================================================

test('§E5 teeth: jobHasExactStep is scoped to the ci: job and demands exact equality', () => {
  assert.equal(
    jobHasExactStep(GOOD_CI_YAML, 'ci', EXPECTED_CI_STEP).ok,
    true,
    'known-good: the exact step inside the ci: job must be seen',
  );

  const onlyInE2e = GOOD_CI_YAML.replace(`      ${EXPECTED_CI_STEP}\n`, '').replace(
    '      - run: just e2e',
    `      ${EXPECTED_CI_STEP}\n      - run: just e2e`,
  );
  assert.equal(
    jobHasExactStep(onlyInE2e, 'ci', EXPECTED_CI_STEP).ok,
    false,
    'known-bad: the step living in the e2e: job must not satisfy a ci:-job assertion',
  );

  const commented = GOOD_CI_YAML.replace(
    `      ${EXPECTED_CI_STEP}`,
    `      # ${EXPECTED_CI_STEP}`,
  );
  assert.equal(
    jobHasExactStep(commented, 'ci', EXPECTED_CI_STEP).ok,
    false,
    'known-bad: a commented-out step must be REJECTED',
  );

  const suffixed = GOOD_CI_YAML.replace(
    `      ${EXPECTED_CI_STEP}`,
    `      ${EXPECTED_CI_STEP} || true`,
  );
  assert.equal(
    jobHasExactStep(suffixed, 'ci', EXPECTED_CI_STEP).ok,
    false,
    'known-bad: `|| true` on the step must be REJECTED',
  );

  const noCiJob = GOOD_CI_YAML.replace('  ci:', '  not-ci:');
  assert.equal(
    jobHasExactStep(noCiJob, 'ci', EXPECTED_CI_STEP).ok,
    false,
    'non-vacuity: a workflow with no ci: job at all must be REJECTED, never a vacuous pass',
  );
});

test('§E6 EARS-1: the REAL ci.yml ci: job runs the step, exactly', () => {
  const ciYaml = readReal(CI_YML_PATH);
  const result = jobHasExactStep(ciYaml, 'ci', EXPECTED_CI_STEP);
  assert.equal(
    result.ok,
    true,
    `EARS-1: ${result.reason}. Add \`${EXPECTED_CI_STEP}\` to the ci: job — the bare exact form ` +
      'is what evals/ci-gate-wiring.eval.mjs matches against the justfile dep list.',
  );
});

test('§E7 teeth: stepIsUnneutered catches if:/continue-on-error: on THIS step (the shared eval does not)', () => {
  assert.equal(
    stepIsUnneutered(GOOD_CI_YAML, EXPECTED_CI_STEP).ok,
    true,
    'known-good: a bare step must be accepted',
  );

  const withIf = GOOD_CI_YAML.replace(
    `      ${EXPECTED_CI_STEP}`,
    [
      '      - name: Tier-2 observability validation',
      '        if: false',
      '        run: just observability-validate',
    ].join('\n'),
  );
  assert.equal(
    jobHasExactStep(withIf, 'ci', EXPECTED_CI_STEP).ok,
    false,
    'known-bad: rewriting the step into name/if/run form drops the exact `- run:` line, which the ' +
      'exact-step predicate already rejects',
  );

  const bareWithIf = GOOD_CI_YAML.replace(
    `      ${EXPECTED_CI_STEP}`,
    `      ${EXPECTED_CI_STEP}\n        if: \${{ github.event_name == 'push' }}`,
  );
  assert.equal(
    stepIsUnneutered(bareWithIf, EXPECTED_CI_STEP).ok,
    false,
    'known-bad: an if: on the step must be REJECTED — a conditional gate is a gate that can be skipped',
  );

  const bareWithCoe = GOOD_CI_YAML.replace(
    `      ${EXPECTED_CI_STEP}`,
    `      ${EXPECTED_CI_STEP}\n        continue-on-error: true`,
  );
  assert.equal(
    stepIsUnneutered(bareWithCoe, EXPECTED_CI_STEP).ok,
    false,
    'known-bad: `continue-on-error: true` must be REJECTED — the step runs and cannot fail',
  );

  const bareWithFalseCoe = GOOD_CI_YAML.replace(
    `      ${EXPECTED_CI_STEP}`,
    `      ${EXPECTED_CI_STEP}\n        continue-on-error: false`,
  );
  assert.equal(
    stepIsUnneutered(bareWithFalseCoe, EXPECTED_CI_STEP).ok,
    true,
    'known-good: an explicitly FALSE continue-on-error is not a neutering and must be accepted',
  );
});

test('§E8 EARS-1: the REAL observability-validate step carries no if: and no truthy continue-on-error:', () => {
  const ciYaml = readReal(CI_YML_PATH);
  const result = stepIsUnneutered(ciYaml, EXPECTED_CI_STEP);
  assert.equal(
    result.ok,
    true,
    `${result.reason} — ciStepsUnneutered only inspects its 7 hardcoded REQUIRED_JUST_STEPS, so ` +
      'this assertion is the only thing covering the new step.',
  );
});

test('§E9 exactly ONE non-comment line in the REAL ci.yml mentions observability-validate (no accidental double-run)', () => {
  const twoMentions = GOOD_CI_YAML.replace(
    `      ${EXPECTED_CI_STEP}`,
    `      ${EXPECTED_CI_STEP}\n      ${EXPECTED_CI_STEP}`,
  );
  assert.equal(
    countNonCommentMentions(twoMentions, VALIDATE_RECIPE),
    2,
    'teeth: the counter must actually count duplicated mentions',
  );
  assert.equal(
    countNonCommentMentions(GOOD_CI_YAML, VALIDATE_RECIPE),
    1,
    'teeth: the known-good fixture mentions the verb exactly once',
  );

  const ciYaml = readReal(CI_YML_PATH);
  assert.equal(
    countNonCommentMentions(ciYaml, VALIDATE_RECIPE),
    1,
    'the REAL ci.yml must mention observability-validate on exactly one non-comment line — two ' +
      'means the ~1.6 GB image pull runs twice per CI run, zero means it never runs',
  );
});

// =============================================================================
// §E10 — this suite's own door into the gate
// =============================================================================

test('§E10 teeth: the test: recipe predicate is body-scoped and comment-blind', () => {
  const goodBody = recipeCommandLines(GOOD_JUSTFILE, 'test');
  assert.ok(
    goodBody.some((line) => line.indexOf(TEST_SUITE_TOKEN) !== -1),
    'known-good: the invocation in the test: body must be seen',
  );

  const commented = GOOD_JUSTFILE.replace(
    `    node --test ${TEST_SUITE_TOKEN}`,
    `    # node --test ${TEST_SUITE_TOKEN}`,
  );
  assert.equal(
    recipeCommandLines(commented, 'test').some((line) => line.indexOf(TEST_SUITE_TOKEN) !== -1),
    false,
    'known-bad: the invocation named only in a comment inside the body must be REJECTED',
  );

  const parkedElsewhere = GOOD_JUSTFILE.replace(
    `    node --test ${TEST_SUITE_TOKEN}`,
    '    cargo test --doc --workspace',
  ).replace('lint:', `dead-recipe:\n    node --test ${TEST_SUITE_TOKEN}\n\nlint:`);
  assert.equal(
    recipeCommandLines(parkedElsewhere, 'test').some(
      (line) => line.indexOf(TEST_SUITE_TOKEN) !== -1,
    ),
    false,
    'known-bad: the invocation parked in a dead recipe must not satisfy the test: recipe',
  );
});

test('§E10b the REAL justfile test: recipe invokes this suite (the door this gate walks through)', () => {
  const justfileText = readReal(JUSTFILE_PATH);
  const body = recipeCommandLines(justfileText, 'test');
  assert.notEqual(body, null, 'the justfile must still have a `test:` recipe at column 0');
  assert.ok(
    body.some((line) => line.indexOf(TEST_SUITE_TOKEN) !== -1),
    `the \`test:\` recipe body must invoke ${TEST_SUITE_TOKEN} — a gating suite nothing runs is ` +
      `not a gate. Body was: ${JSON.stringify(body)}`,
  );
});
