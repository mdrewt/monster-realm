#!/usr/bin/env node
// Portable secret scanner (no deps) for local/lefthook use. CI uses gitleaks.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const SKIP = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'site-packages',
  '.agents', // derived skill vendoring (`npx skills add`); reinstalled from skills-lock.json
]);
const PATTERNS = [
  [/-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, 'private key'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key id'],
  [/\bsk-[A-Za-z0-9]{20,}\b/, 'API secret token'],
  [/\bghp_[A-Za-z0-9]{36}\b/, 'GitHub PAT'],
  [/(password|secret|api_?key)\s*[:=]\s*["'][^"']{8,}["']/i, 'hardcoded credential'],
];
let hits = 0;
async function walk(d) {
  for (const e of await readdir(d, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    // Skip symlinks: a local pre-commit scanner must not crash on a dangling
    // link (e.g. derived skill symlinks into a not-yet-vendored .agents/), nor
    // follow links out of the tree or into cycles. gitleaks (CI) is authoritative.
    if (e.isSymbolicLink()) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      await walk(p);
      continue;
    }
    // Skip env files: .env / .env.* are gitignored by contract (never committed)
    // and .env.example holds placeholders. gitleaks (CI) is the authoritative
    // commit-time scanner; skipping these avoids false positives on a developer's
    // real local .env, which would otherwise break `just security` / `just ci`.
    if (e.name === '.env' || e.name.startsWith('.env.')) continue;
    let s;
    try {
      s = await stat(p);
    } catch {
      continue; // racey unlink / unreadable entry — skip, never crash the scan
    }
    if (s.size > 1_000_000) continue;
    let txt;
    try {
      txt = await readFile(p, 'utf8');
    } catch {
      continue;
    }
    for (const [re, label] of PATTERNS) {
      if (re.test(txt)) {
        console.error(`secret: possible ${label} in ${path.relative(root, p)}`);
        hits++;
      }
    }
  }
}
await walk(root);
if (hits) {
  console.error(`check-secrets: ${hits} potential secret(s) found.`);
  process.exit(1);
}
console.log('check-secrets: clean.');
