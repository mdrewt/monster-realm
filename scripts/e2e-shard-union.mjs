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
//
// The lower attempts change no verdict; they are read only for a shard whose highest attempt
// is readable. A test unexpected on one of them and expected on the highest attempt passed only
// on a rerun: it gets a `rerun-passed:` line and a `::warning` annotation, and a lower attempt
// with no readable e2e.json gets a `rerun-unreadable:` line. When GITHUB_STEP_SUMMARY names a
// file, the same listing is appended to it as a table, on a failing run too. GitHub caps a
// step's annotations; the table is the complete list.
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every test of a Playwright JSON report: `tests` as "<spec id>/<project>  <file>:<line>", and
 * `byId` from "<spec id>/<project>" to its status, file, line and title.
 */
function testsOf(path) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const tests = [];
  const byId = new Map();
  const walk = (suite, describes) => {
    for (const spec of suite.specs ?? []) {
      // A title is one line: it is printed on one stdout line and in one table row.
      const title = [...describes, spec.title].join(' › ').replace(/\r\n|\r|\n/g, ' ');
      for (const t of spec.tests) {
        tests.push(`${spec.id}/${t.projectId}  ${spec.file}:${spec.line}`);
        byId.set(`${spec.id}/${t.projectId}`, {
          status: t.status,
          file: spec.file,
          line: spec.line,
          title,
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...describes, child.title]);
  };
  // A top-level suite is a spec file; its title is the file name, not part of a test's title.
  for (const suite of report.suites) walk(suite, []);
  return { stats: report.stats, tests, byId };
}

/** `testsOf(path)`, or null when the file is missing or is not a readable report. */
function readableTestsOf(path) {
  try {
    return testsOf(path);
  } catch {
    return null;
  }
}

/** GitHub workflow-command escaping of a message, and of a property value. */
const escapeData = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

const dir = process.argv[2];
if (!dir) {
  console.error('usage: e2e-shard-union.mjs <dir of shard artifacts>');
  process.exit(64);
}
const problems = [];
const listed = new Set();
const ran = new Map();
/** Each shard's attempts as { shard, attempts: [{ attempt, name }] ascending }, in shard order. */
function attemptsByShard(names) {
  const byShard = new Map();
  for (const name of names) {
    const m = /^e2e-timings-(\d+)-(\d+)$/.exec(name);
    if (!m) {
      problems.push(`${name}: not an e2e-timings-<shard>-<attempt> artifact`);
      continue;
    }
    const [shard, attempt] = [Number(m[1]), Number(m[2])];
    if (!byShard.has(shard)) byShard.set(shard, []);
    byShard.get(shard).push({ attempt, name });
  }
  return [...byShard.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([shard, attempts]) => ({
      shard,
      attempts: attempts.sort((x, y) => x.attempt - y.attempt),
    }));
}
const shards = attemptsByShard(existsSync(dir) ? readdirSync(dir) : []);
if (shards.length === 0) problems.push(`no shard artifacts in ${dir}`);
const rerunPassed = [];
const unreadable = [];
for (const { shard, attempts } of shards) {
  const highest = attempts[attempts.length - 1];
  const name = highest.name;
  const reportPath = join(dir, name, 'e2e.json');
  const listPath = join(dir, name, 'e2e-list.json');
  const suite = readableTestsOf(listPath);
  const report = readableTestsOf(reportPath);
  if (!suite || !report || typeof report.stats !== 'object' || report.stats === null) {
    problems.push(`${name}: e2e.json or e2e-list.json is missing or unreadable`);
    continue;
  }
  for (const t of suite.tests) listed.add(t);
  const { stats, tests, byId } = report;
  console.log(`${name}: ${tests.length} tests ${JSON.stringify(stats)}`);
  if (tests.length === 0) problems.push(`${name}: ran no tests`);
  if (stats.unexpected > 0 || stats.flaky > 0) {
    problems.push(`${name}: ${stats.unexpected} unexpected, ${stats.flaky} flaky`);
  }
  for (const t of tests) {
    if (ran.has(t)) problems.push(`in both ${ran.get(t)} and ${name}: ${t}`);
    ran.set(t, name);
  }

  /** "<spec id>/<project>" -> the lower attempts that had it unexpected, ascending. */
  const failedOn = new Map();
  for (const { attempt, name: lower } of attempts.slice(0, -1)) {
    const earlier = readableTestsOf(join(dir, lower, 'e2e.json'));
    if (!earlier) {
      unreadable.push(lower);
      continue;
    }
    for (const [id, t] of earlier.byId) {
      if (t.status !== 'unexpected') continue;
      if (!failedOn.has(id)) failedOn.set(id, []);
      failedOn.get(id).push(attempt);
    }
  }
  const listing = [];
  for (const [id, failed] of failedOn) {
    const t = byId.get(id);
    if (t?.status === 'expected') listing.push({ ...t, shard, failed, passed: highest.attempt });
  }
  listing.sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line);
  rerunPassed.push(...listing);
}

for (const t of rerunPassed) {
  const path = `client/e2e/${t.file}`;
  const failed = t.failed.join(',');
  console.log(
    `rerun-passed: ${path}:${t.line} shard ${t.shard} failed on attempt ${failed} passed on attempt ${t.passed}: ${t.title}`,
  );
  const message = `${t.title} (shard ${t.shard}, failed on attempt ${failed}, passed on attempt ${t.passed})`;
  console.log(
    `::warning file=${escapeProperty(path)},line=${t.line},title=Passed only on a rerun::${escapeData(message)}`,
  );
}
for (const name of unreadable) console.log(`rerun-unreadable: ${name}: no readable e2e.json`);

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  const out = ['## e2e tests that passed only on a rerun', ''];
  if (rerunPassed.length === 0) out.push('No e2e test passed only on a rerun.');
  else {
    out.push('| Test | File | Shard | Failed on attempt | Passed on attempt |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const t of rerunPassed) {
      const title = t.title.replace(/\|/g, '\\|');
      const failed = t.failed.join(', ');
      out.push(
        `| ${title} | \`client/e2e/${t.file}:${t.line}\` | ${t.shard} | ${failed} | ${t.passed} |`,
      );
    }
  }
  if (unreadable.length > 0) out.push('');
  for (const name of unreadable) out.push(`Unreadable: ${name} had no readable e2e.json.`);
  // The summary is a report, not a rule: a failed write is named and changes no verdict.
  try {
    appendFileSync(summaryPath, `${out.join('\n')}\n`);
  } catch (err) {
    console.error(
      `e2e-shard-union: cannot write the step summary to ${summaryPath}: ${err.message}`,
    );
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
