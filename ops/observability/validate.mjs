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
// Usage:  node ops/observability/validate.mjs

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const OPS_DIR = import.meta.dirname;

// Dummy values for the `:?`-required variables so `docker compose config` can render without a
// real .env. These are placeholders for a SYNTAX check — they are never used to run anything.
const RENDER_ENV = {
  ...process.env,
  MR_SPACETIME_DATA_DIR: '/var/lib/spacetime',
  GF_SECURITY_ADMIN_PASSWORD: 'validate-only-placeholder',
  MR_ALERT_WEBHOOK_URL: 'http://127.0.0.1:9999/validate-only',
  MR_GRAFANA_BASIC_AUTH_HASH: 'validate-only-placeholder',
};

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

const IMAGES = {
  prometheus:
    'prom/prometheus:v3.13.2@sha256:1147c92841726a6fef55fe6124491d6f85480f8de204f7d420304ca5bbd0a8f7',
  alloy:
    'grafana/alloy:v1.18.1@sha256:754409730f1a4ed9781f8a2ea3b6a8c55750ee125a267ecf8fb449f9a25c109a',
  loki: 'grafana/loki:3.7.6@sha256:83c76da7858a8f4f88117ac521864ac33896fdae7a352a1df4068556e7513f64',
  tempo:
    'grafana/tempo:2.10.7@sha256:6616b00287a4d7001951b5de117828ad5c6f93744935c1b7a5e044736373352c',
};

const CADDY_VALIDATE_TAG = 'mr-caddy-validate:local';

/**
 * Caddy needs a parseable bcrypt hash to adapt the Caddyfile, so one is GENERATED here at run
 * time rather than committed. A committed hash-shaped literal would be a standing false positive
 * for the repo's secret scanners (gitleaks runs remote-only, so it would red CI after the push),
 * and there is no reason to persist a value that authenticates nothing.
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
      'validate-only-authenticates-nothing',
    ],
    { stdio: 'pipe' },
  );
  return out.toString().trim();
}

const results = [];

if (!hasDocker()) {
  results.push({
    label: 'all tool-backed checks',
    status: 'skipped',
    detail: 'docker is not available — Tier-2 validation did NOT run (this is not a pass)',
  });
} else {
  results.push(
    run('docker compose config', 'docker', ['compose', 'config', '--quiet'], { env: RENDER_ENV }),
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
  );

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
  if (build.status === 'pass') {
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
        `MR_GRAFANA_BASIC_AUTH_HASH=${throwawayBcrypt()}`,
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
  }
}

let failed = 0;
for (const r of results) {
  if (r.status === 'fail') failed++;
  const line = `validate ${r.status.toUpperCase()}: ${r.label}`;
  console.log(r.status === 'pass' ? line : `${line} — ${r.detail}`);
}
console.log(`\nvalidate.mjs: ${results.length} check(s), ${failed} failed`);
console.log(`(config root: ${path.relative(process.cwd(), OPS_DIR) || '.'})`);
process.exit(failed ? 1 : 0);
