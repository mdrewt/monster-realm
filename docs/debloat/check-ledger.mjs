// Validates docs/debloat/ledger.ndjson: coverage, verification, pairs closure.
// Usage: node docs/debloat/check-ledger.mjs   (exit 1 on any failure)

import { execSync } from 'node:child_process';
import fs from 'node:fs';

const REPO = new URL('../..', import.meta.url).pathname;
const problems = [];
const rows = fs
  .readFileSync(`${REPO}/docs/debloat/ledger.ndjson`, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      problems.push(`line ${i + 1}: not JSON`);
      return null;
    }
  })
  .filter(Boolean);

const byPath = new Map();
for (const r of rows) {
  if (r.path) {
    byPath.set(r.path, (byPath.get(r.path) ?? []).concat(r));
  }
}

// 1. Coverage: every checking artifact and doc has at least one row.
const tracked = execSync('git ls-files', { cwd: REPO }).toString().trim().split('\n');
const needsRow = (f) =>
  (f.startsWith('evals/') && f.endsWith('.mjs')) ||
  /^server-module\/src\/.*_tests\.rs$/.test(f) ||
  (f.startsWith('game-core/tests/') && f.endsWith('.rs')) ||
  (f.startsWith('client/') && /\.(test\.ts|spec\.ts|test\.mjs)$/.test(f)) ||
  (f.endsWith('.md') && !f.startsWith('docs/debloat/')) ||
  (f.startsWith('scripts/') && f.endsWith('.mjs')) ||
  (f.startsWith('ops/') && /\.(mjs|ya?ml)$/.test(f)) ||
  f.startsWith('.github/workflows/');
const uncovered = tracked.filter((f) => needsRow(f) && !byPath.has(f));
for (const f of uncovered) problems.push(`uncovered artifact: ${f}`);

// 2. Recipes: every justfile recipe has a row (paths are "justfile#<name>").
const justfile = fs.readFileSync(`${REPO}/justfile`, 'utf8');
for (const m of justfile.matchAll(/^([A-Za-z][A-Za-z0-9_-]*)\s*(?:\+[^:]*)?:(?!=)/gm)) {
  if (!byPath.has(`justfile#${m[1]}`)) problems.push(`uncovered recipe: ${m[1]}`);
}

// 3. Row integrity.
const DISP = new Set([
  'KEEP',
  'KEEP-SHRUNK',
  'REPLACE-FIRST',
  'DELETE',
  'EXTRACT',
  'MERGE',
  'FIX-IN-PHASE-3',
]);
for (const r of rows) {
  if (r.kind === 'bug') {
    if (!r.id?.startsWith('BUG-')) problems.push(`bug row without BUG- id: ${r.path}`);
    continue;
  }
  if (!DISP.has(r.disposition)) problems.push(`${r.id}: bad disposition ${r.disposition}`);
  if (r.status !== 'verified') problems.push(`${r.id}: unverified row`);
  if (
    ['DELETE', 'EXTRACT', 'MERGE', 'REPLACE-FIRST'].includes(r.disposition) &&
    !r.verifier &&
    r.classifier !== 'bucket-policy'
  )
    problems.push(`${r.id}: destructive disposition without a second key`);
  if (r.disposition === 'DELETE' && !r.reason_none_needed && !r.adjudication)
    problems.push(`${r.id}: DELETE without adjudication/reason`);
  if (['REPLACE-FIRST', 'MERGE'].includes(r.disposition) && !r.new_home)
    problems.push(`${r.id}: ${r.disposition} without new_home`);
}

// 4. Pairs closure: every pairs[] entry names a resolvable target. Entries are
// "path" or "path (free-text annotation)"; the first token must resolve to a
// tracked file, a ledgered path, the justfile, a tracked directory prefix, or
// a file that existed at the pre-debloat tag and has since been deleted by a
// program batch (a RESOLVED pair — the paired deletion happened).
const trackedSet = new Set(tracked);
const preDebloat = new Set(
  execSync('git ls-tree -r pre-debloat --name-only', { cwd: REPO }).toString().trim().split('\n'),
);
const byId = new Set(rows.map((r) => r.id).filter(Boolean));
const isTrackedDir = (d) => tracked.some((f) => f.startsWith(d.endsWith('/') ? d : `${d}/`));
const isPreDebloatDir = (d) => {
  if (!d) return false;
  const p = d.endsWith('/') ? d : `${d}/`;
  return [...preDebloat].some((f) => f.startsWith(p));
};
const globPrefix = (g) => g.split(/[*{]/)[0].replace(/\/[^/]*$/, '');
for (const r of rows)
  for (const p of r.pairs ?? []) {
    const base = p
      .split(/\s/)[0]
      .replace(/[),.;]+$/, '')
      .split('#')[0]
      .split(':')[0];
    if (!base) continue;
    if (
      trackedSet.has(base) ||
      byPath.has(p) ||
      byPath.has(base) ||
      base === 'justfile' ||
      isTrackedDir(base) ||
      byId.has(base) ||
      fs.existsSync(`${REPO}/${base}`) ||
      preDebloat.has(base) ||
      isPreDebloatDir(base) ||
      (/[*{]/.test(base) && (isTrackedDir(globPrefix(base)) || isPreDebloatDir(globPrefix(base))))
    )
      continue;
    problems.push(`${r.id}: pair target not found: ${p}`);
  }

console.log(
  `ledger: ${rows.length} rows, ${byPath.size} paths, ${rows.filter((r) => r.kind === 'bug').length} bug rows, ${rows.filter((r) => r.flag === 'user-review').length} user-review flags`,
);
if (problems.length) {
  console.error(problems.slice(0, 50).join('\n'));
  console.error(`FAIL: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log('OK');
