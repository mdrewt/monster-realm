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
//
//   summarize rules, applied IN THIS ORDER:
//     1. status allowlist — anything not exactly 'pass'|'fail'|'skipped' → exitCode 1
//     2. any 'fail'                                                     → exitCode 1
//     3. any 'skipped' while requireDocker                              → exitCode 1, reason names it
//     4. no skips and results.length < EXPECTED_MIN_CHECKS              → exitCode 1 (non-vacuity)
//     5. otherwise                                                      → exitCode 0
//
//   THE ENTRY GUARD (measured contract change — a bare `import.meta.main` is NOT enough):
//
//     function isEntryPoint() {
//       if (typeof import.meta.main === 'boolean') return import.meta.main;
//       if (!process.argv[1]) return false;
//       try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
//       catch { return false; }
//     }
//     if (isEntryPoint()) process.exit(main(process.argv.slice(2)));
//
//   `import.meta.main` needs Node >= 24.2; this machine's default `node` is 18.19.1, under
//   which the property is `undefined` → a bare guard never runs main() → SILENT EXIT 0, a
//   false green on every local `just observability-validate` in a default shell. §C3 spawns
//   the module as a non-entry import (must invoke docker ZERO times) and §C4 invokes it
//   through a symlink (must still run). `realpathSync` — not `path.resolve` — is load-bearing:
//   `import.meta.url` is realpath-resolved by the ESM loader, so a symlinked file or a
//   symlinked PARENT DIRECTORY makes a resolve-only comparison silently skip main().
//
//   THE PRINTER (one printer, all statuses, no bypass path):
//     every result line is `validate <STATUS>: <label>` with STATUS = status.toUpperCase(),
//     and STATUS is therefore always one of PASS / FAIL / SKIPPED. The run ends with
//     `validate.mjs: <N> check(s), <M> failed`. §D9 enforces the allowlist on the REAL
//     stdout and §D10 enforces N >= EXPECTED_MIN_CHECKS on the REAL report line — together
//     they are what force main() through summarize() and the printer instead of hand-rolling
//     its own exit code (a correct-but-DEAD exported summarize() passed the previous suite).
//
//   WHAT THE VALIDATOR MUST HAND DOCKER (§D3/§D4 — the mount-source pins):
//     - every `-v` mount SOURCE is the real ops/observability directory, mounted `:ro`;
//     - the `docker compose` invocation names the real ops/observability/docker-compose.yml
//       by ABSOLUTE path (`-f <OPS_DIR>/docker-compose.yml`);
//     - the `docker build` context argument is the real ops/observability directory.
//     cwd is INVISIBLE to an argv recorder, so without these three pins a validator can
//     build a stub config tree in mkdtempSync(), mount THAT, and record byte-identical argv.
//
// THE CHEATS THIS SUITE EXISTS TO KILL (each one scored 47/47 against the previous revision):
//   C1 "n/a"      — run one real check, give the rest status:'n/a'.
//                   Killed by: §A4 (pure allowlist), §D9 (RUNTIME allowlist on stdout).
//   C2 "pass"     — same shrink, phantom results labelled 'pass'.
//                   Killed by: §D2/§D5/§D7/§D10 — a phantom pass records no argv and cannot
//                   raise the report line's check count.
//   C3 "busybox"  — keep all checks but repoint the images/config paths.
//                   Killed by: §A3 (every IMAGES value verbatim in the committed compose file).
//   C4 "dummy probe" (/tmp/rtA) — replace every check with `docker version --format '<literal
//                   containing the image digest and config path>'`; real docker prints the
//                   literal and exits 0 unconditionally.
//                   Killed by: §D6 (exactly ONE `version` probe; every other invocation must
//                   begin run/compose/build), §D9 (`validate N/A:`), §D10 (2 checks < floor).
//   C5 "no guard" (/tmp/rtB) — no entry guard at all, `try { process.exit(main(...)) } catch {}`.
//                   Killed by: §C3 (import the module with a RECORDING docker shim on PATH —
//                   stdout must be empty and the invocation log must be empty).
//   C6 "stub mount" (/tmp/rtC) — real images, real relative config paths, real exit
//                   propagation, but a mkdtempSync() stub tree mounted at /work.
//                   Killed by: §D3 (mount source), §D4 (absolute compose path + build context).
//
// HARD RULES honoured here (CI-enforced):
//   - NO `new RegExp(...)` anywhere — literal regex literals and String methods only
//     (Semgrep detect-non-literal-regexp has bitten this repo 3×).
//   - Real files are resolved from `import.meta.dirname`, never `process.cwd()`.
//   - No conditional skips anywhere: no platform guards, no "skip if docker absent", no
//     "skip if just absent". Docker is never REQUIRED — it is either scrubbed off PATH or
//     replaced by a recorded shim. `just` IS required by §E2/§E4 and its absence FAILS
//     (a wiring gate that silently skips when its oracle is missing is not a gate).
//   - PORTABILITY, stated honestly rather than over-claimed: §A/§B/§E are pure and run
//     anywhere. §C/§D need a POSIX-ish host — they write a `#!/bin/sh` shim, chmod it +x,
//     and need an EXEC-able tmpdir (a `noexec` /tmp reds them), and §C5 needs symlink
//     creation. That is the price of proving argv instead of trusting it.
//   - Subprocesses spawn `process.execPath`, never the bare string 'node': with PATH scrubbed,
//     'node' fails ENOENT and a `notEqual(status, 0)` assertion would pass VACUOUSLY without the
//     validator ever running. For the same reason no assertion in this file is satisfiable by
//     `status === null` (a killed child / failed spawn) — see §B2.
//   - PATH is scrubbed by pointing it at a fresh EMPTY directory. `delete env.PATH` and `env: {}`
//     do NOT hide docker — measured: libuv falls back to the confstr(_CS_PATH) default
//     `/bin:/usr/bin` and still finds it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

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
// skip path) and with process.exit patched to THROW.
//
// This block is a SAFETY NET, not a gate: a cheat can swallow the throw (measured —
// /tmp/rtB wraps the call in try/catch and keeps importError null). The real entry-guard
// proof is §C4, which is behavioural and cannot be swallowed.
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
        'body at import time. It needs the isEntryPoint() guard (see this file’s header).',
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
/** Never throws on the RED state (IMAGES undefined); non-vacuity is asserted in §A4. */
const IMAGE_MAP = IMAGES !== null && typeof IMAGES === 'object' ? IMAGES : {};

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

/**
 * Call the exported main() with docker made INVISIBLE for the duration.
 *
 * WHY the PATH scrub: §B exercises argv REJECTION, which the contract puts before any docker
 * work. Calling main() with the ambient PATH would, against an implementation that validates
 * argv after hasDocker(), run the real ~1.6 GB image gauntlet INSIDE the test process — a
 * multi-minute-per-case hang during which node:test's own timeout cannot fire (execFileSync
 * blocks the event loop) and §D6, which exists to forbid exactly that ordering, never reports.
 * With PATH scrubbed the wrong-ordered implementation is fast AND still fails, loudly, here.
 */
function callMainWithoutDocker(argv) {
  const scrubDir = makeTempDir('mr-validate-inproc-');
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = scrubDir;
    return main(argv);
  } finally {
    process.env.PATH = priorPath;
  }
}

// =============================================================================
// §A — pure summarize / export-contract tests
// =============================================================================

test('§A1 the module exports the contracted API', () => {
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
  const imageCount = Object.keys(IMAGE_MAP).length;
  assert.ok(imageCount >= 4, `IMAGES must still hold the 4 pinned stack images, got ${imageCount}`);
  assert.equal(
    EXPECTED_MIN_CHECKS,
    imageCount + 3,
    'EXPECTED_MIN_CHECKS must be Object.keys(IMAGES).length + 3 — a second hand-maintained ' +
      'constant is exactly the thing that silently drifts down as checks are deleted',
  );
});

// DELIBERATE PIN, do not loosen: `image` must appear VERBATIM in the committed compose file.
// The point is that the validator runs the byte-identical digest the stack deploys. If you are
// here because you bumped an image, the fix is to bump it in BOTH files — not to relax this to
// a repository-name or tag-prefix match, which is precisely how `busybox:latest` (and, later, a
// digest one patch release behind production) slips through while all eight checks stay green.
test('§A3 every IMAGES value is the digest-pinned image the committed compose file deploys', () => {
  const compose = readReal(COMPOSE_PATH);
  const entries = Object.entries(IMAGE_MAP);
  assert.ok(
    entries.length >= 4,
    `non-vacuity: IMAGES must have >= 4 entries, got ${entries.length}`,
  );
  for (const [service, image] of entries) {
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
  { name: "'n/a' (the measured /tmp/rtA cheat's label for six deleted checks)", status: 'n/a' },
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
          'ALLOWLIST, not a blacklist — every one of these shapes exited 0 in the red-team pass.',
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
// Only the REJECTED shapes are exercised in-process, and they run with PATH scrubbed
// (see callMainWithoutDocker) so a wrongly-ordered implementation fails fast and loudly
// instead of hanging the test process on a real image pull. The ACCEPTED shapes run as
// subprocesses; their real end-to-end behaviour is §C/§D.
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
  test(`§B1 main(argv) rejects ${bad.name} with exit code 64`, { timeout: 5_000 }, () => {
    const code = callMainWithoutDocker(bad.argv);
    assert.equal(
      code,
      64,
      'unrecognised argv must return EX_USAGE (64) — not 0 (which would make a typo in the ' +
        'justfile recipe a silent no-op gate) and not 1 (indistinguishable from a real failure). ' +
        'This case runs with docker hidden, so returning 0/1 here also means argv is validated ' +
        'AFTER hasDocker() — which §D6 forbids outright.',
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
    // NOT `notEqual(status, 64)`: that passes VACUOUSLY when status is null (spawn failure or a
    // timeout-killed child). The accepted shapes have exactly two legal outcomes here — 0 (EARS-3,
    // no flag) and 1 (EARS-2, --require-docker with docker hidden).
    assert.ok(
      res.status === 0 || res.status === 1,
      `\`node validate.mjs ${argv.join(' ')}\` must be an ACCEPTED argv shape that actually RAN: ` +
        `expected exit 0 or 1, got ${res.status} (null = the child never ran or was killed). ` +
        `stdout: ${res.stdout} stderr: ${res.stderr}`,
    );
  }
});

test('§B3 the usage message for a rejected argv goes to STDERR, not stdout', {
  timeout: 5_000,
}, () => {
  const out = [];
  const err = [];
  const realLog = console.log;
  const realError = console.error;
  let code;
  try {
    console.log = (...args) => out.push(args.join(' '));
    console.error = (...args) => err.push(args.join(' '));
    code = callMainWithoutDocker(['--nope']);
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
// §C — subprocess behaviour: docker genuinely unavailable, and the ENTRY GUARD.
// =============================================================================

function runValidator(argv, env, scriptPath = VALIDATE_PATH) {
  const res = spawnSync(process.execPath, [scriptPath, ...argv], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    output: `${res.stdout ?? ''}\n${res.stderr ?? ''}`,
  };
}

// --- the ONE printer's status vocabulary, enforced on real stdout -------------
const ALLOWED_STATUS_TOKENS = ['PASS', 'FAIL', 'SKIPPED'];

/** Every `validate <TOKEN>:` prefix printed by the run, in order. */
function printedStatusTokens(output) {
  const tokens = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('validate ')) continue; // 'validate.mjs:' has no space — not a status line
    const rest = line.slice('validate '.length);
    const colon = rest.indexOf(':');
    if (colon === -1) continue;
    tokens.push(rest.slice(0, colon));
  }
  return tokens;
}

function assertStatusVocabulary(output, context) {
  const tokens = printedStatusTokens(output);
  assert.ok(
    tokens.length > 0,
    `${context}: the run printed no \`validate <STATUS>: <label>\` line at all — a validator that ` +
      `reports nothing cannot be audited. Output:\n${output}`,
  );
  for (const token of tokens) {
    assert.ok(
      ALLOWED_STATUS_TOKENS.indexOf(token) !== -1,
      `${context}: printed \`validate ${token}:\` — the RUNTIME status vocabulary is the allowlist ` +
        `${JSON.stringify(ALLOWED_STATUS_TOKENS)}. A result carrying any other status must have been ` +
        'rejected by summarize() rule 1 before it could ever be printed, so seeing one here proves ' +
        'main() does NOT route its results through summarize() (measured: /tmp/rtA exports a ' +
        `correct summarize(), never calls it, and prints \`validate N/A:\`). Output:\n${output}`,
    );
  }
}

test('§C1 EARS-2: --require-docker with docker absent → exit 1, marked FAIL, with no false-comfort skip line', () => {
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
  const tokens = printedStatusTokens(output);
  assert.ok(
    tokens.indexOf('FAIL') !== -1,
    `EARS-2: the strict run must print a \`validate FAIL: …\` line — the exit code alone is not a ` +
      `report. Printed statuses: ${JSON.stringify(tokens)}. Output:\n${output}`,
  );
  // The banned thing is the LINE, not the word: `validate SKIPPED: …` next to a failing exit code
  // is the exact false-comfort this slice exists to remove. The word may still appear in prose
  // ("… did NOT run, so this is not a skip"), and summarize()'s reason string is free to say it.
  // The contract-faithful way to satisfy this is one ternary at the push site —
  //   status: requireDocker ? 'fail' : 'skipped'
  // — which keeps the single printer and the single summarize() call intact. Do NOT special-case
  // the strict path with a bypass message that skips the printer: that IS the cheat shape.
  assert.equal(
    tokens.indexOf('SKIPPED'),
    -1,
    `EARS-2: the strict run must not print a \`validate SKIPPED:\` line. Printed statuses: ` +
      `${JSON.stringify(tokens)}. Output:\n${output}`,
  );
  assertStatusVocabulary(output, 'strict run, docker absent');
  assert.ok(
    output.indexOf('docker') !== -1,
    `the failure must say docker was unavailable. Output:\n${output}`,
  );
  assert.ok(
    output.indexOf('--require-docker') !== -1,
    `the failure must name the flag that made it fatal, so the reader knows the lax path exists. Output:\n${output}`,
  );
});

test('§C2 EARS-3: no flag with docker absent → exit 0, output says SKIPPED and "this is not a pass"', () => {
  const scrubDir = makeTempDir('mr-validate-nodocker-lax-');
  const { status, output } = runValidator([], { ...process.env, PATH: scrubDir });
  assert.equal(
    status,
    0,
    `EARS-3: the laptop path (no flag, no docker) must still exit 0. Got ${status}. Output:\n${output}`,
  );
  assert.ok(
    printedStatusTokens(output).indexOf('SKIPPED') !== -1,
    `EARS-3: the skip must be LOUD — a \`validate SKIPPED: …\` line must be printed. Output:\n${output}`,
  );
  assertStatusVocabulary(output, 'lax run, docker absent');
  assert.ok(
    output.indexOf('this is not a pass') !== -1,
    `EARS-3: the existing "(this is not a pass)" phrasing must survive — a skip and a pass are ` +
      `different words here on purpose. Output:\n${output}`,
  );
});

test('§C3 the entry guard is BEHAVIOURAL: importing the module invokes docker ZERO times', () => {
  // A structural assertion ("importing it did not throw from the patched process.exit") is
  // swallowable — measured: /tmp/rtB has NO entry guard at all, just
  //   try { process.exit(main(process.argv.slice(2))) } catch {}
  // and passed, because the module-scope import above runs with PATH scrubbed and therefore
  // takes the invisible fast skip path. So this test imports the module for real, with a
  // RECORDING docker shim on PATH: a module with no guard runs its whole body here and both
  // the shim log and stdout give it away.
  const { dir, logPath } = makeDockerShim('ok');
  const importUrl = pathToFileURL(VALIDATE_PATH).href;
  const res = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(importUrl)})`], {
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: dir },
    encoding: 'utf8',
    timeout: 180_000,
  });
  const invocations = readInvocations(logPath);
  assert.equal(
    res.status,
    0,
    `importing validate.mjs as a NON-entry module must succeed quietly, got exit ${res.status}. ` +
      `stdout: ${res.stdout} stderr: ${res.stderr}`,
  );
  assert.equal(
    res.stdout,
    '',
    `importing validate.mjs printed to stdout — the module body ran at import time. A module that ` +
      `reports and exits merely by being imported cannot be unit-tested, and its process.exit() ` +
      `terminates \`node --test\` before a single test registers (a zero-test file exits 0: a ` +
      `vacuous green). stdout was:\n${res.stdout}`,
  );
  assert.deepEqual(
    invocations,
    [],
    `importing validate.mjs invoked docker ${invocations.length} time(s):\n` +
      `${describeInvocations(invocations)}\nThe body must run only behind isEntryPoint().`,
  );
});

test('§C4 the entry guard survives SYMLINKED invocation (realpathSync, not path.resolve)', () => {
  // `import.meta.url` is realpath-resolved by the ESM loader, so comparing it to a merely
  // RESOLVED process.argv[1] is unequal whenever the script — or any parent directory — is
  // reached through a symlink. The guard then silently skips main() and the process exits 0:
  // a false green that looks exactly like success. Both symlink shapes are exercised because
  // they fail independently.
  const scrubDir = makeTempDir('mr-validate-symlink-path-');
  const cases = [];

  const fileLinkDir = makeTempDir('mr-validate-symlink-file-');
  const linkedFile = path.join(fileLinkDir, 'validate.mjs');
  symlinkSync(VALIDATE_PATH, linkedFile);
  cases.push({ name: 'the validator itself symlinked into another directory', script: linkedFile });

  const parentLinkDir = makeTempDir('mr-validate-symlink-parent-');
  const linkedParent = path.join(parentLinkDir, 'observability');
  symlinkSync(OPS_DIR, linkedParent);
  cases.push({
    name: 'a symlinked PARENT directory (the checkout reached through a link)',
    script: path.join(linkedParent, 'validate.mjs'),
  });

  try {
    for (const testCase of cases) {
      const { status, output } = runValidator(
        ['--require-docker'],
        { ...process.env, PATH: scrubDir },
        testCase.script,
      );
      assert.equal(
        status,
        1,
        `${testCase.name}: invoking the validator through a symlink with docker absent and ` +
          `--require-docker must still FAIL (exit 1). Got ${status}` +
          `${status === 0 ? ' — a silent 0 means the entry guard skipped main() entirely, which is ' + 'the false green this test exists to catch' : ''}` +
          `. Output:\n${output}`,
      );
    }
  } finally {
    rmSync(linkedParent, { force: true });
    rmSync(linkedFile, { force: true });
  }
});

// =============================================================================
// §D — the killer tooth: an argv-RECORDING `docker` shim.
//
// A `#!/bin/sh` script named `docker` appends its ARGV (tab-separated, so tokens are exact
// rather than split on spaces) to a log and exits 0, printing something version-shaped for
// `docker version` so hasDocker() succeeds. Every assertion below is on the RECORDED
// INVOCATIONS, so an implementation that fabricates result objects records nothing and dies.
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
    '{',
    "  printf 'ARGV'",
    '  for a in "$@"; do',
    '    printf \'\\t%s\' "$a"',
    '  done',
    "  printf '\\n'",
    `} >> '${logPath}'`,
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

/** [{ tokens: string[], text: string }] — one entry per recorded `docker …` invocation. */
function readInvocations(logPath) {
  let text = '';
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    text = '';
  }
  const invocations = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('ARGV')) continue;
    const tokens = line.split('\t').slice(1);
    invocations.push({ tokens, text: tokens.join(' ') });
  }
  return invocations;
}

/** The single `docker version` capability probe hasDocker() is allowed to make. */
function isProbe(invocation) {
  return invocation.tokens[0] === 'version';
}

/** The only invocation shapes that can validate anything. */
const VALIDATING_VERBS = ['run', 'compose', 'build'];
function isValidatingShape(invocation) {
  return VALIDATING_VERBS.indexOf(invocation.tokens[0]) !== -1;
}

/** Mount specs (`<source>:<target>[:opts]`) named by -v / --volume in one invocation. */
function mountSpecs(invocation) {
  const specs = [];
  for (let i = 0; i < invocation.tokens.length - 1; i++) {
    const token = invocation.tokens[i];
    if (token === '-v' || token === '--volume') specs.push(invocation.tokens[i + 1]);
  }
  return specs;
}

function mountSource(spec) {
  const colon = spec.indexOf(':');
  return colon === -1 ? spec : spec.slice(0, colon);
}

/** `validate.mjs: <N> check(s), <M> failed` → { checks, failed }, or null if absent/unparseable. */
function parseReportLine(output) {
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('validate.mjs:')) continue;
    const rest = line.slice('validate.mjs:'.length).trim();
    const comma = rest.indexOf(',');
    if (comma === -1) return null;
    const checks = Number.parseInt(rest, 10);
    const failed = Number.parseInt(rest.slice(comma + 1).trim(), 10);
    if (Number.isNaN(checks) || Number.isNaN(failed)) return null;
    return { checks, failed, line };
  }
  return null;
}

// One spawn, memoised, shared by §D1..§D5 and §D9/§D10 (the shim is deterministic and
// side-effect free).
let recordedRun = null;
function runUnderRecordingShim() {
  if (recordedRun === null) {
    const { dir, logPath } = makeDockerShim('ok');
    const run = runValidator(['--require-docker'], { ...process.env, PATH: dir });
    recordedRun = { ...run, invocations: readInvocations(logPath) };
  }
  return recordedRun;
}

function describeInvocations(invocations) {
  return invocations.map((invocation, i) => `  [${i}] docker ${invocation.text}`).join('\n');
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

// The invocation floor and the per-check assertions below are derived from THIS EXPLICIT LIST
// of checks — deliberately NOT from Object.keys(IMAGES).length. Pinning an image is not the
// same act as validating a config with it: the stack may legitimately pin an image (a sidecar,
// an exporter, a future service) that has no config validator of its own, and that should not
// red this suite. Adding a CHECK, on the other hand, belongs here.
const EXPECTED_IMAGE_CHECKS = [
  { imageKey: 'prometheus', config: 'prometheus.yml' },
  { imageKey: 'prometheus', config: 'rules/recording.rules.yml' },
  { imageKey: 'alloy', config: 'alloy/config.alloy' },
  { imageKey: 'loki', config: 'loki/loki-config.yml' },
  { imageKey: 'tempo', config: 'tempo/tempo-config.yml' },
];

for (const check of EXPECTED_IMAGE_CHECKS) {
  test(`§D2 '${check.config}' is validated BY the pinned ${check.imageKey} image, in one real invocation`, () => {
    const { invocations, output } = runUnderRecordingShim();
    const image = IMAGE_MAP[check.imageKey];
    assert.equal(
      typeof image,
      'string',
      `IMAGES.${check.imageKey} must exist for this check to be expressible`,
    );
    const shaped = invocations.filter(isValidatingShape);
    const matching = shaped.filter(
      (invocation) =>
        invocation.tokens.indexOf(image) !== -1 && invocation.text.indexOf(check.config) !== -1,
    );
    assert.ok(
      matching.length > 0,
      `no recorded run/compose/build invocation names BOTH IMAGES.${check.imageKey} ('${image}') ` +
        `and '${check.config}'. Co-mention in ONE invocation is the point: a phantom 'pass' result ` +
        'records nothing, and smuggling the image and the path into `docker version --format` ' +
        `no-ops records neither as a validating shape (measured, /tmp/rtA). Recorded ` +
        `${invocations.length} invocation(s):\n${describeInvocations(invocations)}\n---\n` +
        `Validator output:\n${output}`,
    );
  });
}

test('§D3 every -v mount SOURCE is the real ops/observability directory, mounted read-only', () => {
  const { invocations, output } = runUnderRecordingShim();
  const specs = invocations.flatMap((invocation) => mountSpecs(invocation));
  assert.ok(
    specs.length > 0,
    `not one recorded invocation mounted anything with -v. The image validators can only see the ` +
      `config tree through a bind mount, so zero mounts means zero configs were read. Recorded ` +
      `${invocations.length} invocation(s):\n${describeInvocations(invocations)}\n---\n` +
      `Validator output:\n${output}`,
  );
  for (const spec of specs) {
    assert.equal(
      mountSource(spec),
      OPS_DIR,
      `the mount '${spec}' does not come from the real config tree ${OPS_DIR}. THIS is the ` +
        'assertion the argv recorder was blind to: a validator can build a stub tree in ' +
        'mkdtempSync(), mount THAT at /work, and record argv byte-identical to the honest ' +
        'implementation (measured, /tmp/rtC — all 8 checks, real digests, real relative config ' +
        'paths, real exit propagation, and a corrupted docker-compose.yml/prometheus.yml/' +
        'Caddyfile all undetected). cwd is invisible here; the mount source is not.',
    );
    assert.ok(
      spec.endsWith(':ro'),
      `the mount '${spec}' is not read-only. The committed config tree is the INPUT to this ` +
        'validation, never its output — a writable bind mount lets a container edit the files ' +
        'it was asked to check.',
    );
  }
});

test('§D4 the compose check names the REAL docker-compose.yml by absolute path, and the build context is the real tree', () => {
  const { invocations, output } = runUnderRecordingShim();
  const context = `Recorded ${invocations.length} invocation(s):\n${describeInvocations(
    invocations,
  )}\n---\nValidator output:\n${output}`;

  // DELIBERATE PIN, do not loosen to a relative path: `-f docker-compose.yml` + a cwd is
  // indistinguishable, in the recording, from `-f docker-compose.yml` + a cwd pointing at a
  // three-line stub. The absolute path is the only part of a compose invocation that proves
  // WHICH file was rendered.
  const composeInvocations = invocations.filter((invocation) => invocation.tokens[0] === 'compose');
  assert.ok(
    composeInvocations.length > 0,
    `no \`docker compose …\` invocation was recorded. ${context}`,
  );
  for (const invocation of composeInvocations) {
    assert.ok(
      invocation.tokens.indexOf(COMPOSE_PATH) !== -1,
      `\`docker compose\` must be pointed at the committed file by absolute path ` +
        `(\`-f ${COMPOSE_PATH}\`); this invocation names no such token. ${context}`,
    );
  }

  const buildInvocations = invocations.filter((invocation) => invocation.tokens[0] === 'build');
  assert.ok(
    buildInvocations.length > 0,
    `no \`docker build …\` invocation was recorded. ${context}`,
  );
  assert.ok(
    buildInvocations.some((invocation) => invocation.tokens.indexOf(OPS_DIR) !== -1),
    `no \`docker build\` invocation passes ${OPS_DIR} as its build context — building the Caddy ` +
      `validation image from a stub directory proves nothing about the committed Dockerfile. ${context}`,
  );
});

// DELIBERATE PIN, do not loosen: these filenames are hardcoded rather than globbed from the
// directory. A glob would silently shrink the moment a config file is renamed or deleted; this
// list reds and makes a human decide. If you are here because a config was legitimately renamed,
// rename it here too — do not soften the predicate.
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
  test(`§D5 the committed config '${configFile}' is named in a real run/compose/build invocation`, () => {
    const { invocations, output } = runUnderRecordingShim();
    const shaped = invocations.filter(isValidatingShape);
    assert.ok(
      shaped.some((invocation) => invocation.text.indexOf(configFile) !== -1),
      `no recorded run/compose/build invocation names '${configFile}'. Pointing a check at ` +
        `/dev/null, deleting the check and fabricating its result, and smuggling the filename into ` +
        `a \`docker version --format\` literal all look like this. Recorded ${invocations.length} ` +
        `invocation(s):\n${describeInvocations(invocations)}\n---\nValidator output:\n${output}`,
    );
  });
}

test('§D6 invocation SHAPE: exactly one `version` probe, everything else is run/compose/build', () => {
  const { invocations, output } = runUnderRecordingShim();
  const context = `Recorded ${invocations.length} invocation(s):\n${describeInvocations(
    invocations,
  )}\n---\nValidator output:\n${output}`;
  const probes = invocations.filter(isProbe);
  assert.equal(
    probes.length,
    1,
    `\`docker version\` is a CAPABILITY PROBE, not a check: hasDocker() gets exactly one, and a ` +
      `second one is a red flag, not a rounding error. Real docker prints whatever Go template it ` +
      `is handed and exits 0 no matter what any config file contains, which makes ` +
      `\`docker version --format '<the image digest and config path the suite greps for>'\` a ` +
      `perfect forgery of a check (measured, /tmp/rtA: 6 of them, 47/47 green, three corrupted ` +
      `config files undetected). Got ${probes.length}. ${context}`,
  );
  for (const invocation of invocations) {
    if (isProbe(invocation)) continue;
    assert.ok(
      isValidatingShape(invocation),
      `\`docker ${invocation.tokens[0]} …\` cannot validate a config file. Every invocation other ` +
        `than the single hasDocker() probe must begin with one of ${JSON.stringify(VALIDATING_VERBS)}. ` +
        context,
    );
  }
});

test('§D7 the number of VALIDATING invocations is at least EXPECTED_MIN_CHECKS (the check set did not shrink)', () => {
  const { invocations, output } = runUnderRecordingShim();
  // Counting only run/compose/build is load-bearing: an unfiltered count is met for free by the
  // hasDocker() probe plus any number of `docker version` no-ops, so the floor stopped being a
  // floor the moment a cheat could pad it.
  const shaped = invocations.filter(isValidatingShape);
  assert.ok(
    shaped.length >= EXPECTED_MIN_CHECKS,
    `only ${shaped.length} validating docker invocation(s) were recorded (of ${invocations.length} ` +
      `total), below the EXPECTED_MIN_CHECKS floor of ${EXPECTED_MIN_CHECKS}:\n` +
      `${describeInvocations(invocations)}\n---\nValidator output:\n${output}`,
  );
});

test('§D8 a rejected argv shape returns 64 WITHOUT invoking docker even once', () => {
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

test('§D9 RUNTIME status allowlist: every printed status is PASS / FAIL / SKIPPED', () => {
  const { output } = runUnderRecordingShim();
  assertStatusVocabulary(output, 'full run under the recording shim');
});

test('§D10 the validator’s OWN report line counts at least EXPECTED_MIN_CHECKS checks', () => {
  const { output, invocations } = runUnderRecordingShim();
  const report = parseReportLine(output);
  assert.notEqual(
    report,
    null,
    `the run must end with a \`validate.mjs: <N> check(s), <M> failed\` line — this suite asserts ` +
      `on the validator's own report, not only on the shim log, because a validator can invoke ` +
      `docker plenty while reporting on almost none of it. Output:\n${output}`,
  );
  assert.ok(
    report.checks >= EXPECTED_MIN_CHECKS,
    `the report line says '${report.line}' — ${report.checks} check(s), below the ` +
      `EXPECTED_MIN_CHECKS floor of ${EXPECTED_MIN_CHECKS}. Measured cheat: ship 2 results (one of ` +
      `them status 'n/a'), fire six \`docker version\` no-ops, and compute the exit code by hand. ` +
      `Recorded ${invocations.length} invocation(s):\n${describeInvocations(invocations)}`,
  );
  assert.equal(
    report.failed,
    0,
    `the all-succeeding shim run must report 0 failed, got ${report.failed}. Output:\n${output}`,
  );
});

test('§D11 negative control: a real check failure propagates — `docker compose config` fails → exit 1 and the check is named', () => {
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
    printedStatusTokens(output).indexOf('FAIL') !== -1,
    `the output must mark the check with a \`validate FAIL:\` line, not merely list it. Output:\n${output}`,
  );
  const report = parseReportLine(output);
  assert.notEqual(
    report,
    null,
    `the failing run must still print its report line. Output:\n${output}`,
  );
  assert.ok(
    report.failed >= 1,
    `the report line must count the failure, got '${report.line}'. Output:\n${output}`,
  );
});

// =============================================================================
// §E — wiring (EARS-1). Every predicate gets known-bad inline fixtures FIRST
// (repo convention), then runs against the REAL committed justfile / ci.yml.
//
// Every assertion is SCOPED to the right recipe body or job block: an unscoped exact-line
// match is defeated by parking the literal line in a dead recipe (measured).
//
// For the justfile, the PRIMARY oracle is `just --dump --dump-format json` — just's own
// parser — because a hand-rolled text parser has two measured bypasses that both leave
// `just --dry-run ci` running `@echo "neutered"` (see §E4b). The text predicates are kept as
// corroboration and get extra structural teeth (one header at column 0, no `[attribute]`
// line above it, no `allow-duplicate-recipes` anywhere).
// =============================================================================

const VALIDATE_RECIPE = 'observability-validate';
const EXPECTED_RECIPE_LINE = 'node ops/observability/validate.mjs --require-docker';
const EXPECTED_CI_STEP = '- run: just observability-validate';
const CI_RUN_FORM = 'just observability-validate';
const TEST_SUITE_TOKEN = 'ops/observability/validate.test.mjs';

// --- justfile extractors -----------------------------------------------------

/**
 * The dep list on a recipe's HEADER line (column 0, non-comment). null if no such recipe.
 * Everything from the first `#` is stripped BEFORE splitting: `ci: lint # observability-validate`
 * satisfies a naive split while `just --dry-run ci` never runs the dep (measured).
 */
function recipeHeaderDeps(justfileText, recipeName) {
  for (const line of justfileText.split('\n')) {
    if (line.length === 0) continue;
    if (line[0] === ' ' || line[0] === '\t') continue; // recipe headers sit at column 0
    if (line.trim().startsWith('#')) continue;
    if (!line.startsWith(`${recipeName}:`) && !line.startsWith(`${recipeName} `)) continue;
    const hash = line.indexOf('#');
    const code = hash === -1 ? line : line.slice(0, hash);
    const colon = code.indexOf(':');
    if (colon === -1) return [];
    return code
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

/**
 * { ok, reason } — the text parser is reading the definition `just` will actually RUN.
 *
 * Two measured bypasses make this necessary, and both score `ok: true` on a first-match text
 * parser while `just --dry-run ci` runs `@echo "neutered"`:
 *   1. `set allow-duplicate-recipes := true` + a second definition later in the file (just takes
 *      the LAST, a first-match parser takes the first);
 *   2. `[windows]` on the honest definition and `[linux]` on the neutered one (just takes the
 *      platform-enabled one, a first-match parser takes whichever is written first).
 */
function recipeHeaderIntegrity(justfileText, recipeName) {
  const lines = justfileText.split('\n');
  const headerIndexes = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    if (line[0] === ' ' || line[0] === '\t') continue;
    if (line.trim().startsWith('#')) continue;
    if (line.startsWith(`${recipeName}:`) || line.startsWith(`${recipeName} `))
      headerIndexes.push(i);
  }
  if (headerIndexes.length === 0) {
    return { ok: false, reason: `justfile has no \`${recipeName}:\` header at column 0` };
  }
  if (headerIndexes.length !== 1) {
    return {
      ok: false,
      reason:
        `\`${recipeName}:\` is defined ${headerIndexes.length} times at column 0 (lines ` +
        `${headerIndexes.map((i) => i + 1).join(', ')}) — with duplicates, the definition this ` +
        'suite reads and the definition `just` runs are not the same one',
    };
  }
  for (let i = headerIndexes[0] - 1; i >= 0; i--) {
    const above = lines[i].trim();
    if (above === '') break;
    if (above.startsWith('#')) continue;
    if (above.startsWith('[')) {
      return {
        ok: false,
        reason:
          `\`${recipeName}:\` is preceded by the attribute line '${above}' — platform attributes ` +
          '(`[linux]`/`[windows]`/`[macos]`) select between same-named recipes at run time, so the ' +
          'definition read here need not be the one that runs',
      };
    }
    break;
  }
  for (const line of lines) {
    if (line.trim().startsWith('#')) continue;
    if (line.indexOf('allow-duplicate-recipes') !== -1) {
      return {
        ok: false,
        reason:
          '`allow-duplicate-recipes` is set in the justfile — a later duplicate silently wins in ' +
          '`just` while a text parser keeps reading the first one',
      };
    }
  }
  return { ok: true, reason: 'single unattributed definition' };
}

// --- `just --dump` (just's own parser, used as the oracle) --------------------

function dumpJustfileAt(justfilePath, workingDir) {
  const attempts = [
    [
      '--justfile',
      justfilePath,
      '--working-directory',
      workingDir,
      '--unstable',
      '--dump',
      '--dump-format',
      'json',
    ],
    [
      '--justfile',
      justfilePath,
      '--working-directory',
      workingDir,
      '--dump',
      '--dump-format',
      'json',
    ],
  ];
  const failures = [];
  for (const args of attempts) {
    const res = spawnSync('just', args, { cwd: workingDir, encoding: 'utf8', timeout: 60_000 });
    if (res.error) {
      failures.push(`spawn \`just\`: ${res.error.message}`);
      continue;
    }
    if (res.status !== 0) {
      failures.push(
        `\`just ${args.join(' ')}\` exited ${res.status}: ${(res.stderr ?? '').trim()}`,
      );
      continue;
    }
    try {
      return { ok: true, dump: JSON.parse(res.stdout), reason: 'just --dump --dump-format json' };
    } catch (err) {
      failures.push(`unparseable JSON from \`just --dump\`: ${err.message}`);
    }
  }
  return { ok: false, dump: null, reason: failures.join(' | ') };
}

// One spawn for the real justfile, shared by §E2/§E4.
const JUST_DUMP = dumpJustfileAt(JUSTFILE_PATH, REPO_ROOT);

/**
 * Fails LOUDLY (never skips) when `just` is missing or its dump is unusable. A wiring gate whose
 * oracle is optional is a wiring gate that is off exactly where it matters — CI installs `just`,
 * and a developer without it cannot run `just ci` either.
 */
function assertDumpAvailable(dumpResult) {
  assert.ok(
    dumpResult.ok,
    `\`just --dump --dump-format json\` is unavailable, so the justfile wiring cannot be checked ` +
      `against just's OWN parser: ${dumpResult.reason}. This is a FAILURE, not a skip — install ` +
      '`just` (CI does, via extractions/setup-just).',
  );
}

/** Dep names from the dump, tolerating both the string and { recipe } dependency encodings. */
function dumpDeps(dump, recipeName) {
  const recipe = dump && dump.recipes ? dump.recipes[recipeName] : undefined;
  if (!recipe) return null;
  return (recipe.dependencies ?? []).map((dep) => {
    if (typeof dep === 'string') return dep;
    if (typeof dep.recipe === 'string') return dep.recipe;
    if (dep.recipe && typeof dep.recipe.name === 'string') return dep.recipe.name;
    return JSON.stringify(dep);
  });
}

/** Flattened, comment-stripped body lines from the dump (`@`/`-` prefixes are preserved). */
function dumpBodyLines(dump, recipeName) {
  const recipe = dump && dump.recipes ? dump.recipes[recipeName] : undefined;
  if (!recipe) return null;
  return (recipe.body ?? [])
    .map((line) =>
      (Array.isArray(line) ? line : [line])
        .map((fragment) => (typeof fragment === 'string' ? fragment : JSON.stringify(fragment)))
        .join(''),
    )
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
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

/**
 * `continue-on-error:` is an ALLOWLIST, not a blacklist: the only value that is not a neutering
 * is exactly `false`.
 *
 * A truthy blacklist (`true|yes|on|True`) misses `TRUE`, `YES`, `Yes`, `ON`, `On` — all valid
 * YAML booleans — and misses the expression forms GitHub officially accepts here, e.g.
 * `${{ !cancelled() }}` and `${{ success() }}`, which evaluate truthy in exactly the runs that
 * matter.
 */
function coeValueIsExplicitlyFalse(rawValue) {
  let value = rawValue.trim();
  const comment = value.indexOf(' #');
  if (comment !== -1) value = value.slice(0, comment).trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    value = value.slice(1, -1).trim();
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).trim();
  }
  return value.toLowerCase() === 'false';
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
 * { ok, reason } — within the step's own line range there is no `if:` and no
 * `continue-on-error:` other than an explicit `false`.
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
      const value = trimmed.slice('continue-on-error:'.length);
      if (!coeValueIsExplicitlyFalse(value)) {
        return {
          ok: false,
          reason: `step '${exactStep}' carries continue-on-error:${value} — only an explicit \`false\` is not a neutering`,
        };
      }
    }
  }
  return { ok: true, reason: 'step is unneutered' };
}

/**
 * { ok, reason } — the JOB's own keys carry no `if:` and no non-`false` `continue-on-error:`.
 * A job-level neutering disables every step inside it at once, which a step-scoped scan cannot
 * see at all.
 */
function jobIsUnneutered(yaml, jobName) {
  const block = extractJobBlock(yaml, jobName);
  if (block.trim() === '') {
    return { ok: false, reason: `ci.yml has no \`${jobName}:\` job block (no vacuous pass)` };
  }
  for (const line of block.split('\n')) {
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent !== 4) continue; // job-level mapping keys only; step keys are indented >= 6
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('- ')) continue;
    if (trimmed.startsWith('if:')) {
      return {
        ok: false,
        reason:
          `the \`${jobName}:\` job carries a JOB-LEVEL if: (${trimmed}) — every step in it, ` +
          'including this gate, can be skipped wholesale',
      };
    }
    if (trimmed.startsWith('continue-on-error:')) {
      const value = trimmed.slice('continue-on-error:'.length);
      if (!coeValueIsExplicitlyFalse(value)) {
        return {
          ok: false,
          reason:
            `the \`${jobName}:\` job carries a JOB-LEVEL continue-on-error:${value} — the ` +
            'whole job, gate included, cannot fail',
        };
      }
    }
  }
  return { ok: true, reason: 'job is unneutered' };
}

function countNonCommentMentions(text, token) {
  let count = 0;
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('#')) continue;
    if (line.indexOf(token) !== -1) count++;
  }
  return count;
}

// --- the `test:` recipe's fail-closed wrapper --------------------------------

// Node 24's DEFAULT test reporter prints `ℹ pass 47` — NOT the TAP `# pass 47`. A wrapper that
// greps for the TAP token alone matches nothing, its `pass` variable comes back empty, and with
// `set -eu` (no `pipefail`) and the comparisons sitting inside `if`, the whole wrapper stays
// green on a genuinely failing suite. Hence: the glyph (or an explicit TAP reporter), and
// `pipefail` on the `node --test … | tee` pipeline, are both real requirements.
const NODE24_PASS_GLYPH = 'ℹ';
const FLOOR_COMPARISONS = [' -lt ', ' -le ', ' -ge ', ' -gt '];
const NOOP_COMMANDS = ['echo', 'ls', 'cat', 'printf', 'true', ':', 'test', '['];
const SUITE_FILTER_FLAGS = ['--test-name-pattern', '--test-skip-pattern', '--test-only'];
const NEUTERING_SUFFIXES = ['|| true', '|| :', '; exit 0', '; true', '&& true'];

/**
 * { ok, reason } — the `test:` recipe runs THIS suite behind a fail-closed wrapper.
 *
 * `readScript(relativePath) -> string | null` is injected so the inline fixtures below can
 * exercise the predicate without touching the filesystem.
 */
function testGateResult(justfileText, readScript) {
  const body = recipeCommandLines(justfileText, 'test');
  if (body === null) return { ok: false, reason: 'justfile has no `test:` recipe at column 0' };

  const invocationLines = body.filter((line) => line.indexOf(TEST_SUITE_TOKEN) !== -1);
  if (invocationLines.length === 0) {
    return { ok: false, reason: `the \`test:\` body never names ${TEST_SUITE_TOKEN}` };
  }
  if (invocationLines.length > 1) {
    return {
      ok: false,
      reason: `${invocationLines.length} lines of the \`test:\` body name the suite: ${JSON.stringify(invocationLines)}`,
    };
  }

  const line = invocationLines[0];
  if (line.startsWith('-') || line.startsWith('@')) {
    return {
      ok: false,
      reason: `'${line}' carries just's \`${line[0]}\` prefix — \`-\` ignores the exit code outright`,
    };
  }
  for (const suffix of NEUTERING_SUFFIXES) {
    if (line.indexOf(suffix) !== -1) {
      return { ok: false, reason: `'${line}' is neutered by its \`${suffix}\` suffix` };
    }
  }
  const tokens = line.split(/\s+/).filter(Boolean);
  const command = tokens[0].split(';')[0];
  if (NOOP_COMMANDS.indexOf(command) !== -1) {
    return {
      ok: false,
      reason: `'${line}' does not RUN the suite — \`${command}\` merely mentions the path`,
    };
  }
  for (const flag of SUITE_FILTER_FLAGS) {
    if (line.indexOf(flag) !== -1) {
      return {
        ok: false,
        reason: `'${line}' passes ${flag} — a filtered run can select ZERO tests and exit 0`,
      };
    }
  }
  if (tokens.length === 3 && tokens[0] === 'node' && tokens[1] === '--test') {
    return {
      ok: false,
      reason:
        `'${line}' is a bare \`node --test\` invocation. It is not fail-closed: the run can select ` +
        'zero tests, or die before registering any, and still exit 0',
    };
  }

  let gateText = body.join('\n');
  for (const bodyLine of body) {
    for (const token of bodyLine.split(/\s+/).filter(Boolean)) {
      if (token === TEST_SUITE_TOKEN) continue;
      if (token.indexOf('.sh') === -1 && token.indexOf('.bash') === -1) continue;
      const extra = readScript(token);
      if (typeof extra === 'string') gateText += `\n${extra}`;
    }
  }

  const missing = [];
  const hasFloor =
    gateText.indexOf('pass') !== -1 &&
    FLOOR_COMPARISONS.some((operator) => gateText.indexOf(operator) !== -1);
  if (!hasFloor)
    missing.push('a numeric PASS-FLOOR comparison (e.g. `[ "$pass" -lt "$MIN_PASS" ]`)');
  if (gateText.indexOf('exit 1') === -1) missing.push('an `exit 1` on the failure branch');
  if (gateText.indexOf('pipefail') === -1) {
    missing.push('`pipefail` (without it, `node --test … | tee` reports tee’s exit status)');
  }
  if (
    gateText.indexOf(NODE24_PASS_GLYPH) === -1 &&
    gateText.indexOf('--test-reporter=tap') === -1
  ) {
    missing.push(
      `handling for Node 24's default reporter — either the \`${NODE24_PASS_GLYPH} pass N\` glyph ` +
        'or an explicit `--test-reporter=tap`',
    );
  }
  if (missing.length > 0) {
    return { ok: false, reason: `the \`test:\` gate is missing ${missing.join('; ')}` };
  }
  return { ok: true, reason: 'fail-closed wrapper' };
}

// --- inline fixtures ---------------------------------------------------------

const WRAPPER_SCRIPT = 'scripts/node-test-with-floor.sh';
const GOOD_TEST_LINE = `bash ${WRAPPER_SCRIPT} ${TEST_SUITE_TOKEN} 61`;

const GOOD_WRAPPER_TEXT = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'FILE="$1"',
  'MIN_PASS="$2"',
  'out="$(mktemp)"',
  'node --test "$FILE" 2>&1 | tee "$out"',
  `pass="$(grep -Eo "^(${NODE24_PASS_GLYPH}|#) pass [0-9]+" "$out" | grep -Eo "[0-9]+$" | tail -1)"`,
  `fail="$(grep -Eo "^(${NODE24_PASS_GLYPH}|#) fail [0-9]+" "$out" | grep -Eo "[0-9]+$" | tail -1)"`,
  'if [ -z "$pass" ] || [ -z "$fail" ]; then',
  '  echo "could not parse the node --test summary" >&2',
  '  exit 1',
  'fi',
  'if [ "$fail" -ne 0 ]; then exit 1; fi',
  'if [ "$pass" -lt "$MIN_PASS" ]; then exit 1; fi',
].join('\n');

const readGoodWrapper = (relativePath) =>
  relativePath === WRAPPER_SCRIPT ? GOOD_WRAPPER_TEXT : null;

function justfileWithTestBody(bodyLines) {
  return [
    'lint:',
    '    cargo fmt --all --check',
    '',
    'observability-validate:',
    `    ${EXPECTED_RECIPE_LINE}`,
    '',
    'test:',
    ...bodyLines.map((bodyLine) => `    ${bodyLine}`),
    '',
    'ci: lint test observability-validate',
    '',
  ].join('\n');
}

const GOOD_JUSTFILE = justfileWithTestBody(['cargo nextest run --workspace', GOOD_TEST_LINE]);

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
// §E1/§E2 — the ci: recipe HEADER lists the dep
// =============================================================================

test('§E1 teeth: recipeHeaderDeps is scoped to the ci: header line and strips inline comments', () => {
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

  const parkedInInlineComment = GOOD_JUSTFILE.replace(
    'ci: lint test observability-validate',
    'ci: lint test # observability-validate',
  );
  assert.equal(
    recipeHeaderDeps(parkedInInlineComment, 'ci').includes(VALIDATE_RECIPE),
    false,
    'known-bad: `ci: lint test # observability-validate` satisfies a naive whitespace split, but ' +
      '`just --dry-run ci` never runs the dep — everything from the first `#` must be stripped',
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

test('§E2 EARS-1: the REAL justfile ci: recipe depends on observability-validate (per `just --dump`)', () => {
  assertDumpAvailable(JUST_DUMP);
  const deps = dumpDeps(JUST_DUMP.dump, 'ci');
  assert.notEqual(deps, null, 'the justfile must still have a `ci:` recipe');
  assert.ok(
    deps.includes(VALIDATE_RECIPE),
    `EARS-1: \`ci:\` must depend on \`${VALIDATE_RECIPE}\`; just's own dump reports deps ` +
      `${JSON.stringify(deps)}. A ci: DEP (not a body line) is the placement ` +
      'evals/ci-gate-wiring.eval.mjs::justfileCiDepsAppearInCi enforces against ci.yml — a body ' +
      'line is enforced by nothing.',
  );

  const justfileText = readReal(JUSTFILE_PATH);
  assert.ok(
    recipeHeaderDeps(justfileText, 'ci').includes(VALIDATE_RECIPE),
    'the dep must ALSO be visible to the text parser the sibling evals use — if these two ' +
      'oracles disagree, one of them is reading a definition that never runs',
  );
  const integrity = recipeHeaderIntegrity(justfileText, 'ci');
  assert.ok(integrity.ok, `\`ci:\` header integrity: ${integrity.reason}`);
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

test('§E4 teeth: the two measured text-parser bypasses are rejected by the dump oracle and by header integrity', () => {
  // Bypass 1 — `set allow-duplicate-recipes := true`: `just` runs the LAST definition.
  const duplicateDir = makeTempDir('mr-validate-just-dup-');
  const duplicatePath = path.join(duplicateDir, 'justfile');
  writeFileSync(
    duplicatePath,
    [
      'set allow-duplicate-recipes := true',
      '',
      'observability-validate:',
      `    ${EXPECTED_RECIPE_LINE}`,
      '',
      'observability-validate:',
      '    @echo "neutered"',
      '',
      'ci: observability-validate',
      '',
    ].join('\n'),
  );
  const duplicateText = readReal(duplicatePath);
  assert.equal(
    recipeBodyIsExactly(duplicateText, VALIDATE_RECIPE, EXPECTED_RECIPE_LINE).ok,
    true,
    'documenting the measured bypass: the first-match TEXT parser reads the honest definition ' +
      'and reports ok — which is exactly why it cannot be the only oracle',
  );
  const duplicateDump = dumpJustfileAt(duplicatePath, duplicateDir);
  assertDumpAvailable(duplicateDump);
  const duplicateDumpBody = dumpBodyLines(duplicateDump.dump, VALIDATE_RECIPE);
  // Asserted on content rather than byte-equality so the teeth do not hinge on whether just's
  // JSON keeps the `@` inside the first fragment: the load-bearing claim is that the dump
  // reports the definition `just ci` RUNS, which is not the one the text parser read.
  assert.ok(
    duplicateDumpBody.join('\n').indexOf('neutered') !== -1,
    `known-bad: just's own dump must expose the LAST definition — the one \`just ci\` actually ` +
      `runs. Dump reported: ${JSON.stringify(duplicateDumpBody)}`,
  );
  assert.notDeepEqual(
    duplicateDumpBody,
    [EXPECTED_RECIPE_LINE],
    'known-bad: the dump must NOT agree with the first-match text parser here — that disagreement ' +
      'is the whole bypass',
  );
  assert.equal(
    recipeHeaderIntegrity(duplicateText, VALIDATE_RECIPE).ok,
    false,
    'known-bad: header integrity must also reject the duplicate + allow-duplicate-recipes shape',
  );

  // Bypass 2 — platform attributes: `just` runs the `[linux]` one on CI.
  const platformText = [
    '[windows]',
    'observability-validate:',
    `    ${EXPECTED_RECIPE_LINE}`,
    '',
    '[linux]',
    'observability-validate:',
    '    @echo "neutered"',
    '',
    'ci: observability-validate',
    '',
  ].join('\n');
  assert.equal(
    recipeBodyIsExactly(platformText, VALIDATE_RECIPE, EXPECTED_RECIPE_LINE).ok,
    true,
    'documenting the measured bypass: the text parser takes whichever definition is written first',
  );
  const platformIntegrity = recipeHeaderIntegrity(platformText, VALIDATE_RECIPE);
  assert.equal(
    platformIntegrity.ok,
    false,
    'known-bad: a recipe preceded by a `[linux]`/`[windows]` attribute line must be REJECTED — ' +
      'the definition read here is not necessarily the one that runs',
  );

  assert.equal(
    recipeHeaderIntegrity(GOOD_JUSTFILE, VALIDATE_RECIPE).ok,
    true,
    'known-good: a single, unattributed definition must be accepted',
  );
});

test('§E5 EARS-1: the REAL observability-validate recipe body is exactly the strict invocation', () => {
  assertDumpAvailable(JUST_DUMP);
  const dumpBody = dumpBodyLines(JUST_DUMP.dump, VALIDATE_RECIPE);
  assert.notEqual(
    dumpBody,
    null,
    `just's dump has no \`${VALIDATE_RECIPE}\` recipe at all — EARS-1 needs one`,
  );
  assert.deepEqual(
    dumpBody,
    [EXPECTED_RECIPE_LINE],
    `EARS-1/EARS-2 wiring: per just's OWN parser the recipe body must be exactly:\n` +
      `${VALIDATE_RECIPE}:\n    ${EXPECTED_RECIPE_LINE}\n` +
      "Exact equality rejects just's `-`/`@` prefixes and `|| true` / `; exit 0` suffixes.",
  );

  const justfileText = readReal(JUSTFILE_PATH);
  const textResult = recipeBodyIsExactly(justfileText, VALIDATE_RECIPE, EXPECTED_RECIPE_LINE);
  assert.ok(textResult.ok, `the text parser must agree with the dump: ${textResult.reason}`);
  const integrity = recipeHeaderIntegrity(justfileText, VALIDATE_RECIPE);
  assert.ok(integrity.ok, `\`${VALIDATE_RECIPE}:\` header integrity: ${integrity.reason}`);
});

// =============================================================================
// §E6..§E10 — the ci.yml step
// =============================================================================

test('§E6 teeth: jobHasExactStep is scoped to the ci: job and demands exact equality', () => {
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

test('§E7 EARS-1: the REAL ci.yml ci: job runs the step, exactly', () => {
  const ciYaml = readReal(CI_YML_PATH);
  const result = jobHasExactStep(ciYaml, 'ci', EXPECTED_CI_STEP);
  assert.equal(
    result.ok,
    true,
    `EARS-1: ${result.reason}. Add \`${EXPECTED_CI_STEP}\` to the ci: job — the bare exact form ` +
      'is what evals/ci-gate-wiring.eval.mjs matches against the justfile dep list.',
  );
});

test('§E8 teeth: continue-on-error is an ALLOWLIST — every non-`false` value neuters the step', () => {
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

  // The blacklist this replaces caught `true|yes|on|True` and nothing else. Every value below is
  // a working neutering that it let through.
  const neuteringValues = [
    'true',
    'TRUE',
    'True',
    'yes',
    'YES',
    'Yes',
    'on',
    'ON',
    'On',
    "'true'",
    '"true"',
    '${{ !cancelled() }}',
    '${{ success() }}',
    "${{ github.event_name == 'pull_request' }}",
  ];
  for (const value of neuteringValues) {
    const fixture = GOOD_CI_YAML.replace(
      `      ${EXPECTED_CI_STEP}`,
      `      ${EXPECTED_CI_STEP}\n        continue-on-error: ${value}`,
    );
    assert.equal(
      stepIsUnneutered(fixture, EXPECTED_CI_STEP).ok,
      false,
      `known-bad: \`continue-on-error: ${value}\` must be REJECTED — continue-on-error officially ` +
        'accepts expressions, and every YAML-truthy spelling means the step runs and cannot fail',
    );
  }

  for (const value of ['false', "'false'", '"false"', 'false # explicit, on purpose']) {
    const fixture = GOOD_CI_YAML.replace(
      `      ${EXPECTED_CI_STEP}`,
      `      ${EXPECTED_CI_STEP}\n        continue-on-error: ${value}`,
    );
    assert.equal(
      stepIsUnneutered(fixture, EXPECTED_CI_STEP).ok,
      true,
      `known-good: \`continue-on-error: ${value}\` is not a neutering and must be accepted`,
    );
  }
});

test('§E9 teeth: a JOB-LEVEL if:/continue-on-error: disables the gate wholesale and must be REJECTED', () => {
  assert.equal(
    jobIsUnneutered(GOOD_CI_YAML, 'ci').ok,
    true,
    'known-good: a plain job must be accepted',
  );

  const jobIf = GOOD_CI_YAML.replace(
    '    runs-on: ubuntu-latest\n    steps:\n      - run: just lint',
    "    if: ${{ github.event_name == 'push' }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: just lint",
  );
  assert.equal(
    jobIsUnneutered(jobIf, 'ci').ok,
    false,
    'known-bad: a job-level if: skips every step in the job, including this gate — and a ' +
      'step-scoped scan cannot see it at all',
  );

  for (const value of ['true', 'TRUE', '${{ !cancelled() }}']) {
    const jobCoe = GOOD_CI_YAML.replace(
      '    runs-on: ubuntu-latest\n    steps:\n      - run: just lint',
      `    continue-on-error: ${value}\n    runs-on: ubuntu-latest\n    steps:\n      - run: just lint`,
    );
    assert.equal(
      jobIsUnneutered(jobCoe, 'ci').ok,
      false,
      `known-bad: a job-level \`continue-on-error: ${value}\` must be REJECTED`,
    );
  }

  // The REAL ci.yml has a step-level `continue-on-error: true` on the dependency-review step.
  // The job-level scan must NOT see it: only keys indented exactly 4 are the job's own.
  const stepLevelCoe = GOOD_CI_YAML.replace(
    '      - run: just lint',
    '      - uses: actions/dependency-review-action@v4\n        continue-on-error: true\n      - run: just lint',
  );
  assert.equal(
    jobIsUnneutered(stepLevelCoe, 'ci').ok,
    true,
    'known-good: a continue-on-error on some OTHER step is not a job-level neutering — this ' +
      'assertion is what stops the job scan from false-positiving on the real workflow',
  );
});

test('§E10 EARS-1: the REAL step and the REAL ci: job are both unneutered', () => {
  const ciYaml = readReal(CI_YML_PATH);
  const stepResult = stepIsUnneutered(ciYaml, EXPECTED_CI_STEP);
  assert.equal(
    stepResult.ok,
    true,
    `${stepResult.reason} — ciStepsUnneutered only inspects its 7 hardcoded REQUIRED_JUST_STEPS, ` +
      'so this assertion is the only thing covering the new step.',
  );
  const jobResult = jobIsUnneutered(ciYaml, 'ci');
  assert.equal(jobResult.ok, true, jobResult.reason);
});

test('§E11 exactly ONE non-comment line in the REAL ci.yml RUNS observability-validate', () => {
  // Counting the run FORM (`just observability-validate`), not the bare verb: a
  // `- name: observability-validate` label beside the run line is good practice, not a second
  // ~1.6 GB image pull, and must not red this.
  const twoRuns = GOOD_CI_YAML.replace(
    `      ${EXPECTED_CI_STEP}`,
    `      ${EXPECTED_CI_STEP}\n      ${EXPECTED_CI_STEP}`,
  );
  assert.equal(
    countNonCommentMentions(twoRuns, CI_RUN_FORM),
    2,
    'teeth: the counter must actually count a duplicated RUN line',
  );
  const named = GOOD_CI_YAML.replace(
    `      ${EXPECTED_CI_STEP}`,
    `      - name: observability-validate\n        run: just observability-validate`,
  );
  assert.equal(
    countNonCommentMentions(named, CI_RUN_FORM),
    1,
    'teeth: a `- name: observability-validate` label next to the run line is ONE invocation',
  );

  const ciYaml = readReal(CI_YML_PATH);
  assert.equal(
    countNonCommentMentions(ciYaml, CI_RUN_FORM),
    1,
    'the REAL ci.yml must run observability-validate on exactly one non-comment line — two ' +
      'means the ~1.6 GB image pull runs twice per CI run, zero means it never runs',
  );
});

// =============================================================================
// §E12/§E13 — this suite's own door into the gate
// =============================================================================

test('§E12 teeth: the test: recipe predicate is body-scoped and comment-blind', () => {
  const goodBody = recipeCommandLines(GOOD_JUSTFILE, 'test');
  assert.ok(
    goodBody.some((line) => line.indexOf(TEST_SUITE_TOKEN) !== -1),
    'known-good: the invocation in the test: body must be seen',
  );

  const commented = GOOD_JUSTFILE.replace(`    ${GOOD_TEST_LINE}`, `    # ${GOOD_TEST_LINE}`);
  assert.equal(
    recipeCommandLines(commented, 'test').some((line) => line.indexOf(TEST_SUITE_TOKEN) !== -1),
    false,
    'known-bad: the invocation named only in a comment inside the body must be REJECTED',
  );

  const parkedElsewhere = GOOD_JUSTFILE.replace(
    `    ${GOOD_TEST_LINE}`,
    '    cargo test --doc --workspace',
  ).replace('lint:', `dead-recipe:\n    ${GOOD_TEST_LINE}\n\nlint:`);
  assert.equal(
    recipeCommandLines(parkedElsewhere, 'test').some(
      (line) => line.indexOf(TEST_SUITE_TOKEN) !== -1,
    ),
    false,
    'known-bad: the invocation parked in a dead recipe must not satisfy the test: recipe',
  );
});

test('§E13 teeth: every measured substring-match bypass of the test: gate is REJECTED', () => {
  assert.equal(
    testGateResult(GOOD_JUSTFILE, readGoodWrapper).ok,
    true,
    'known-good: the wrapper-script shape must be accepted',
  );

  // A second accepted shape, so this predicate does not force ONE layout: the wrapper written
  // inline as a `#!/usr/bin/env bash` recipe body.
  const inlineJustfile = justfileWithTestBody([
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'out="$(mktemp)"',
    `node --test ${TEST_SUITE_TOKEN} 2>&1 | tee "$out"`,
    `pass="$(grep -Eo "^(${NODE24_PASS_GLYPH}|#) pass [0-9]+" "$out" | grep -Eo "[0-9]+$" | tail -1)"`,
    'if [ -z "$pass" ]; then exit 1; fi',
    'if [ "$pass" -lt 61 ]; then exit 1; fi',
  ]);
  assert.equal(
    testGateResult(inlineJustfile, readGoodWrapper).ok,
    true,
    'known-good: an inline fail-closed wrapper must be accepted too',
  );

  // Each bypass below keeps the wrapper (and therefore the pass floor) reachable in the gate
  // text wherever possible, so the rule named in `kills` is the ONLY thing that can reject it.
  const sibling = `bash ${WRAPPER_SCRIPT} ops/other/suite.test.mjs 3`;
  const bypasses = [
    { kills: 'the `|| true` suffix', body: [`${GOOD_TEST_LINE} || true`] },
    { kills: 'the `; exit 0` suffix', body: [`${GOOD_TEST_LINE} ; exit 0`] },
    { kills: "just's `-` ignore-error prefix", body: [`-${GOOD_TEST_LINE}`] },
    { kills: "just's `@` quiet prefix", body: [`@${GOOD_TEST_LINE}`] },
    { kills: '`echo` merely printing the path', body: [`echo "${TEST_SUITE_TOKEN}"`, sibling] },
    { kills: '`ls` merely stat-ing the path', body: [`ls ${TEST_SUITE_TOKEN}`, sibling] },
    {
      kills: '`true; # <file>` — a comment, not a run',
      body: [`true; # ${TEST_SUITE_TOKEN}`, sibling],
    },
    { kills: 'a bare `node --test <file>`', body: [`node --test ${TEST_SUITE_TOKEN}`, sibling] },
    {
      kills: '`--test-name-pattern=ZZZ` (selects 0 tests, exits 0)',
      body: [`node --test --test-name-pattern=ZZZ ${TEST_SUITE_TOKEN}`, sibling],
    },
    {
      kills: 'no pass floor anywhere (a plain `node --test`, wrapper-free)',
      body: [`node --test ${TEST_SUITE_TOKEN} --test-reporter=tap`],
    },
    {
      kills: 'a wrapper path that does not exist on disk',
      body: [`bash scripts/absent-wrapper.sh ${TEST_SUITE_TOKEN} 61`],
    },
    { kills: 'the suite never being named at all', body: ['cargo nextest run --workspace'] },
    { kills: 'two lines naming the suite', body: [GOOD_TEST_LINE, GOOD_TEST_LINE] },
  ];
  for (const bypass of bypasses) {
    const result = testGateResult(justfileWithTestBody(bypass.body), readGoodWrapper);
    assert.equal(
      result.ok,
      false,
      `known-bad (${bypass.kills}): ${JSON.stringify(bypass.body)} must be REJECTED — every one of ` +
        'these satisfied the old `body.some(line => line.includes(token))` substring match',
    );
  }

  // The two wrapper-internal properties, isolated: a wrapper that greps only the TAP token finds
  // nothing under Node 24's default reporter, and one without pipefail reports tee's exit status.
  const tapOnlyWrapper = GOOD_WRAPPER_TEXT.split(`(${NODE24_PASS_GLYPH}|#)`).join('(#)');
  assert.equal(
    testGateResult(GOOD_JUSTFILE, (p) => (p === WRAPPER_SCRIPT ? tapOnlyWrapper : null)).ok,
    false,
    "known-bad: Node 24's default reporter prints `ℹ pass N`, so a TAP-token-only grep matches " +
      'nothing, the floor comparison never runs, and the wrapper is green on a failing suite',
  );
  const noPipefailWrapper = GOOD_WRAPPER_TEXT.split('set -euo pipefail').join('set -eu');
  assert.equal(
    testGateResult(GOOD_JUSTFILE, (p) => (p === WRAPPER_SCRIPT ? noPipefailWrapper : null)).ok,
    false,
    'known-bad: without pipefail, `node --test … | tee` reports tee’s exit status and the ' +
      'failing suite is invisible to `set -e`',
  );
});

test('§E13b EARS-1: the REAL justfile test: recipe runs this suite behind a fail-closed wrapper', () => {
  const justfileText = readReal(JUSTFILE_PATH);
  const readCommittedScript = (relativePath) => {
    try {
      return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
    } catch {
      return null;
    }
  };
  const result = testGateResult(justfileText, readCommittedScript);
  assert.equal(
    result.ok,
    true,
    `the \`test:\` recipe is this gating suite's only door into \`just ci\`: ${result.reason}. ` +
      `Body was: ${JSON.stringify(recipeCommandLines(justfileText, 'test'))}`,
  );
  const integrity = recipeHeaderIntegrity(justfileText, 'test');
  assert.ok(integrity.ok, `\`test:\` header integrity: ${integrity.reason}`);
});
