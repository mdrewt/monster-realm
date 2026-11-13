#!/usr/bin/env node
// CI's `e2e` job: proves the e2e shard jobs together ran the whole suite. `--shard` turns off
// Playwright's "no tests found" failure and nothing else ties the matrix to the shard total, so
// a shard that ran nothing, or a total larger than the number of shard jobs, would stay green.
//
//   node scripts/e2e-shard-union.mjs <dir>
//
// <dir> holds one directory per shard artifact, named e2e-timings-<shard>-<run attempt>, each
// with the shard's JSON report (e2e.json) and the listing of the whole suite taken on that
// runner (e2e-list.json). A re-run of failed jobs re-runs only the failed shards, and every
// attempt's artifacts are downloaded together, so each shard is judged by its highest attempt.
// Exits 1 unless every such report has tests and no unexpected or flaky result, no test is in
// two reports, and the reports' tests are exactly the listed tests.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every test of a Playwright JSON report as "<spec id>/<project>  <file>:<line>". */
function testsOf(path) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const tests = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests)
        tests.push(`${spec.id}/${t.projectId}  ${spec.file}:${spec.line}`);
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites) walk(suite);
  return { stats: report.stats, tests };
}

const dir = process.argv[2];
if (!dir) {
  console.error('usage: e2e-shard-union.mjs <dir of shard artifacts>');
  process.exit(64);
}
const problems = [];
const listed = new Set();
const ran = new Map();
/** The artifact directory of each shard's highest attempt, in shard order. */
function latestAttempts(names) {
  const latest = new Map();
  for (const name of names) {
    const m = /^e2e-timings-(\d+)-(\d+)$/.exec(name);
    if (!m) {
      problems.push(`${name}: not an e2e-timings-<shard>-<attempt> artifact`);
      continue;
    }
    const [shard, attempt] = [Number(m[1]), Number(m[2])];
    if (!latest.has(shard) || latest.get(shard).attempt < attempt)
      latest.set(shard, { attempt, name });
  }
  return [...latest.entries()].sort((x, y) => x[0] - y[0]).map(([, v]) => v.name);
}
const shards = latestAttempts(existsSync(dir) ? readdirSync(dir) : []);
if (shards.length === 0) problems.push(`no shard artifacts in ${dir}`);
for (const shard of shards) {
  const reportPath = join(dir, shard, 'e2e.json');
  const listPath = join(dir, shard, 'e2e-list.json');
  if (!existsSync(reportPath) || !existsSync(listPath)) {
    problems.push(`${shard}: e2e.json or e2e-list.json is missing`);
    continue;
  }
  for (const t of testsOf(listPath).tests) listed.add(t);
  const { stats, tests } = testsOf(reportPath);
  console.log(`${shard}: ${tests.length} tests ${JSON.stringify(stats)}`);
  if (tests.length === 0) problems.push(`${shard}: ran no tests`);
  if (stats.unexpected > 0 || stats.flaky > 0) {
    problems.push(`${shard}: ${stats.unexpected} unexpected, ${stats.flaky} flaky`);
  }
  for (const t of tests) {
    if (ran.has(t)) problems.push(`in both ${ran.get(t)} and ${shard}: ${t}`);
    ran.set(t, shard);
  }
}
for (const t of listed) if (!ran.has(t)) problems.push(`listed but in no shard: ${t}`);
for (const t of ran.keys())
  if (!listed.has(t)) problems.push(`in ${ran.get(t)} but not listed: ${t}`);
console.log(`shards: ${ran.size} tests; suite: ${listed.size} tests`);
if (problems.length > 0) {
  for (const p of problems) console.error(`e2e-shard-union: ${p}`);
  process.exit(1);
}
