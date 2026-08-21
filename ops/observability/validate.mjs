#!/usr/bin/env node
// Tier-2 validation for ops/observability/** — schema/syntax checks no string predicate can do.
//
// Runs each upstream validator through THE PINNED IMAGE the stack actually deploys, so what is
// checked is the exact version that will run. Every check is skip-guarded: if docker is absent
// the check reports `skipped` explicitly and loudly. It NEVER silently passes — a skip and a
// pass are different words here on purpose (the `bindings-drift.eval.mjs` idiom).
//
// Tier 1 (the real gate, `checks/stack-config-checks.test.mjs`) is pure text predicates and runs
// with no dependencies at all. This file is the complement, not a replacement.
//
// Usage:  node ops/observability/validate.mjs [--require-docker]
//
//   (no flag)         docker absent → one `skipped` result, exit 0 (the laptop path).
//   --require-docker  docker absent → one `fail` result, exit 1 (the CI path: a gate that
//                     reports `skipped` and exits 0 is a gate that passes while checking
//                     nothing).
//   anything else     usage on stderr, exit 64 (EX_USAGE), before any docker work.
//
// The module body does nothing at import time: all work lives in `main(argv)`, which RETURNS an
// exit code rather than calling process.exit, so the suite can drive it in-process.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OPS_DIR = import.meta.dirname;
const COMPOSE_FILE = path.join(OPS_DIR, 'docker-compose.yml');

// Dummy values for the `:?`-required variables so `docker compose config` can render without a
// real .env. These are placeholders for a SYNTAX check — they are never used to run anything.
// Held in a named constant rather than written inline: `scripts/check-secrets.mjs` flags any
// `password|secret|key`-shaped identifier followed by a quoted 8+ character literal, and would
// (correctly, by its own rules) fire on an inline placeholder here. The indirection keeps the
// repo-wide scanner honest instead of teaching anyone to ignore it.
const PLACEHOLDER = 'validate-only-authenticates-nothing';

const RENDER_ENV = {
  ...process.env,
  MR_SPACETIME_DATA_DIR: '/var/lib/spacetime',
  GF_SECURITY_ADMIN_PASSWORD: PLACEHOLDER,
  MR_ALERT_WEBHOOK_URL: 'http://127.0.0.1:9999/validate-only',
  MR_GRAFANA_BASIC_AUTH_HASH: PLACEHOLDER,
};

const USAGE = 'usage: node ops/observability/validate.mjs [--require-docker]';

/** The only statuses a result may carry. An ALLOWLIST, deliberately — see summarize(). */
const ALLOWED_STATUSES = ['pass', 'fail', 'skipped'];

function hasDocker() {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function run(label, file, args, options) {
  try {
    execFileSync(file, args, { cwd: OPS_DIR, stdio: 'pipe', ...options });
    return { label, status: 'pass', detail: 'ok' };
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    const stdout = err.stdout ? err.stdout.toString().trim() : '';
    return { label, status: 'fail', detail: (stderr || stdout || err.message).slice(0, 800) };
  }
}

/**
 * Run a pinned image's own validator over ops/observability mounted read-only at /work.
 * `extraMounts` adds additional read-only mount points for configs whose internal references are
 * absolute container paths (prometheus.yml's `rule_files:` points at its DEPLOYED location, so
 * validating it requires that path to resolve — rewriting the config to suit the validator would
 * be checking a file the stack never runs).
 *
 * Every mount SOURCE is OPS_DIR itself: an argv recorder cannot see cwd, so the mount source is
 * the only thing in the invocation that proves which config tree was actually read.
 */
function inImage(label, image, argv, extraMounts = []) {
  const mounts = [`${OPS_DIR}:/work:ro`, ...extraMounts.map((m) => `${OPS_DIR}:${m}:ro`)];
  return run(label, 'docker', [
    'run',
    '--rm',
    '--network',
    'none',
    ...mounts.flatMap((m) => ['-v', m]),
    '-w',
    '/work',
    '--entrypoint',
    argv[0],
    image,
    ...argv.slice(1),
  ]);
}

export const IMAGES = {
  prometheus:
    'prom/prometheus:v3.13.2@sha256:1147c92841726a6fef55fe6124491d6f85480f8de204f7d420304ca5bbd0a8f7',
  alloy:
    'grafana/alloy:v1.18.1@sha256:754409730f1a4ed9781f8a2ea3b6a8c55750ee125a267ecf8fb449f9a25c109a',
  loki: 'grafana/loki:3.7.6@sha256:83c76da7858a8f4f88117ac521864ac33896fdae7a352a1df4068556e7513f64',
  tempo:
    'grafana/tempo:2.10.7@sha256:6616b00287a4d7001951b5de117828ad5c6f93744935c1b7a5e044736373352c',
};

/**
 * The non-vacuity floor: one check per pinned image, plus the three that are not image-pinned
 * (`docker compose config`, the Caddy image build, and `caddy validate`). DERIVED from IMAGES
 * rather than hand-typed, because a second hand-maintained constant is exactly the thing that
 * silently drifts down as checks are deleted.
 */
export const EXPECTED_MIN_CHECKS = Object.keys(IMAGES).length + 3;

const CADDY_VALIDATE_TAG = 'mr-caddy-validate:local';

/**
 * Caddy needs a parseable bcrypt hash to adapt the Caddyfile, so one is GENERATED here at run
 * time rather than committed. A committed hash-shaped literal would be a standing false positive
 * for the repo's secret scanners (gitleaks runs remote-only, so it would red CI after the push),
 * and there is no reason to persist a value that authenticates nothing.
 *
 * THROWS on failure. It is called from a statement, never from inside a `run(...)` argument list:
 * as an argument expression its throw escapes run()'s try/catch entirely and kills the whole
 * validator with an unhandled exception — no result, no report line, nothing for summarize() to
 * see. The caller converts a throw into a `fail` result instead.
 */
function throwawayBcrypt() {
  const out = execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'caddy',
      CADDY_VALIDATE_TAG,
      'hash-password',
      '--plaintext',
      PLACEHOLDER,
    ],
    { stdio: 'pipe' },
  );
  return out.toString().trim();
}

/**
 * Reduce a result list to an exit code, applying five rules IN ORDER:
 *
 *   1. status allowlist — anything not exactly pass|fail|skipped → 1 (fail-closed: a blacklist
 *      lets `n/a`, `Skipped`, `failed` and a missing key through);
 *   2. any `fail`                                               → 1;
 *   3. any `skipped` while requireDocker                        → 1, reason names the label(s);
 *   4. no skips and fewer than EXPECTED_MIN_CHECKS results      → 1 (the shrink floor);
 *   5. otherwise                                                → 0.
 */
export function summarize(results, { requireDocker = false } = {}) {
  const list = Array.isArray(results) ? results : [];
  let failed = 0;
  let skipped = 0;
  const skippedLabels = [];
  const unknown = [];

  for (const result of list) {
    const status = result && typeof result.status === 'string' ? result.status : '';
    const label = result && typeof result.label === 'string' ? result.label : '<unlabelled>';
    if (ALLOWED_STATUSES.indexOf(status) === -1) {
      unknown.push(`${label} (status: ${String(result ? result.status : undefined)})`);
    } else if (status === 'fail') {
      failed++;
    } else if (status === 'skipped') {
      skipped++;
      skippedLabels.push(label);
    }
  }

  if (unknown.length > 0) {
    return {
      exitCode: 1,
      failed,
      skipped,
      reason:
        `unrecognised check status on ${unknown.join(', ')} — the status vocabulary is an ` +
        `allowlist (${ALLOWED_STATUSES.join('|')}), so an unknown status is a failure`,
    };
  }
  if (failed > 0) {
    return { exitCode: 1, failed, skipped, reason: `${failed} check(s) failed` };
  }
  if (skipped > 0 && requireDocker) {
    return {
      exitCode: 1,
      failed,
      skipped,
      reason:
        `--require-docker was passed but ${skipped} check(s) were skipped: ` +
        `${skippedLabels.join(', ')}`,
    };
  }
  if (skipped === 0 && list.length < EXPECTED_MIN_CHECKS) {
    return {
      exitCode: 1,
      failed,
      skipped,
      reason:
        `only ${list.length} check(s) ran, below the floor of ${EXPECTED_MIN_CHECKS} — ` +
        'a shrunken check set is not a green one',
    };
  }
  return { exitCode: 0, failed, skipped, reason: '' };
}

/** Every tool-backed check, in order. Only reached when docker is available. */
function runDockerChecks() {
  const results = [
    // `-f <absolute path>` deliberately, not a bare filename plus a cwd: the absolute path is
    // the only part of a compose invocation that proves WHICH file was rendered (and it closes
    // the `COMPOSE_FILE=harmless.yml` environment bypass).
    run('docker compose config', 'docker', ['compose', '-f', COMPOSE_FILE, 'config', '--quiet'], {
      env: RENDER_ENV,
    }),
    inImage(
      'promtool check config',
      IMAGES.prometheus,
      ['promtool', 'check', 'config', 'prometheus.yml'],
      ['/etc/prometheus'],
    ),
    inImage('promtool check rules', IMAGES.prometheus, [
      'promtool',
      'check',
      'rules',
      'rules/recording.rules.yml',
    ]),
    inImage('alloy fmt', IMAGES.alloy, ['alloy', 'fmt', 'alloy/config.alloy']),
    inImage('loki verify-config', IMAGES.loki, [
      'loki',
      '-verify-config',
      '-config.file=loki/loki-config.yml',
    ]),
    // The Tempo image is distroless: no shell, and the binary lives at /tempo (not on PATH).
    inImage('tempo verify-config', IMAGES.tempo, [
      '/tempo',
      '-config.verify',
      '-config.file=tempo/tempo-config.yml',
    ]),
  ];

  // Caddy is the one BUILT image, so its validator needs the build first (cached after the
  // first run). This is the only check that proves `rate_limit` is actually compiled into the
  // binary: an uncompiled plugin makes the directive unrecognized and validation fails, so a
  // silently-stock Caddy cannot pass while the Caddyfile claims a rate limit.
  const build = run('caddy image build', 'docker', [
    'build',
    '--quiet',
    '--tag',
    CADDY_VALIDATE_TAG,
    OPS_DIR,
  ]);
  results.push(build);
  if (build.status !== 'pass') return results;

  // Hoisted OUT of the `run(...)` argument list below so a throw here becomes a reported `fail`
  // instead of an unhandled exception that bypasses the report entirely.
  let hash = '';
  let hashError = null;
  try {
    hash = throwawayBcrypt();
  } catch (err) {
    hashError = err;
  }
  if (hashError !== null) {
    const stderr = hashError.stderr ? hashError.stderr.toString().trim() : '';
    results.push({
      label: 'caddy validate',
      status: 'fail',
      detail: `could not generate the throwaway bcrypt hash: ${(stderr || hashError.message).slice(
        0,
        800,
      )}`,
    });
    return results;
  }

  results.push(
    run('caddy validate', 'docker', [
      'run',
      '--rm',
      '--network',
      'none',
      '-e',
      'MR_CADDY_BIND_ADDR=127.0.0.1',
      '-e',
      'MR_GRAFANA_BASIC_AUTH_USER=operator',
      // A syntactically valid throwaway bcrypt hash. Not a credential: it authenticates
      // nothing, and Caddy only needs a parseable hash to adapt the config.
      '-e',
      `MR_GRAFANA_BASIC_AUTH_HASH=${hash}`,
      '-e',
      'MR_OTLP_ALLOWED_ORIGIN=https://localhost:5173',
      '-v',
      `${OPS_DIR}:/work:ro`,
      '--entrypoint',
      'caddy',
      CADDY_VALIDATE_TAG,
      'validate',
      '--config',
      '/work/Caddyfile',
      '--adapter',
      'caddyfile',
    ]),
  );
  return results;
}

/**
 * Parse argv, run the checks, print the report, and RETURN the exit code.
 *
 * Argv validation runs BEFORE hasDocker(): a validator that pulls 1.6 GB of images and only then
 * complains about its own flags is not argv validation.
 */
export function main(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let requireDocker = false;
  if (args.length === 1 && args[0] === '--require-docker') {
    requireDocker = true;
  } else if (args.length !== 0) {
    console.error(`validate.mjs: unrecognised argument(s): ${args.join(' ')}`);
    console.error(USAGE);
    return 64;
  }

  const results = [];
  if (hasDocker()) {
    results.push(...runDockerChecks());
  } else {
    // ONE result, one status word, one printer. Under --require-docker the status is `fail`,
    // so the run can never print a false-comfort `validate SKIPPED:` line beside exit 1.
    results.push({
      label: 'all tool-backed checks',
      status: requireDocker ? 'fail' : 'skipped',
      detail: requireDocker
        ? 'docker is not available and --require-docker was passed — Tier-2 validation did NOT ' +
          'run, and a run that checked nothing is not a pass'
        : 'docker is not available — Tier-2 validation did NOT run (this is not a pass); pass ' +
          '--require-docker to make this fatal',
    });
  }

  const summary = summarize(results, { requireDocker });
  for (const result of results) {
    const line = `validate ${result.status.toUpperCase()}: ${result.label}`;
    console.log(result.status === 'pass' ? line : `${line} — ${result.detail}`);
  }
  console.log(
    `\nvalidate.mjs: ${results.length} check(s), ${summary.failed} failed, ${summary.skipped} skipped`,
  );
  console.log(`(config root: ${path.relative(process.cwd(), OPS_DIR) || '.'})`);
  if (summary.exitCode !== 0) console.error(`validate.mjs: ${summary.reason}`);
  return summary.exitCode;
}

/**
 * True only when this file is the process entry point.
 *
 * `import.meta.main` needs Node >= 24.2 and is `undefined` below that (the default `node` on a
 * developer box here is 18), so the fallback is required or main() would never run. The fallback
 * uses realpathSync — NOT path.resolve — because `import.meta.url` is realpath-resolved by the
 * ESM loader: a symlinked script, or a symlinked PARENT directory, makes a resolve-only
 * comparison unequal, the guard skips main(), and the process exits 0. That false green looks
 * exactly like success.
 */
function isEntryPoint() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) process.exit(main(process.argv.slice(2)));
