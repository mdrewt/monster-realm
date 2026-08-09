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

/** Run a pinned image's own validator over ops/observability mounted read-only at /work. */
function inImage(label, image, argv) {
  return run(label, 'docker', [
    'run',
    '--rm',
    '--network',
    'none',
    '-v',
    `${OPS_DIR}:/work:ro`,
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
    'grafana/tempo:3.0.2@sha256:aa8df8d069f77b82e978464daf55169bb8d135852ad58700aa96880653c3d8f7',
};

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
    inImage('promtool check config', IMAGES.prometheus, [
      'promtool',
      'check',
      'config',
      'prometheus.yml',
    ]),
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
    inImage('tempo verify-config', IMAGES.tempo, [
      'tempo',
      '-config.verify',
      '-config.file=tempo/tempo-config.yml',
    ]),
  );
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
