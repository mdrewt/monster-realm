// e2e-shard-union.mjs judges each shard by its highest run attempt: a re-run of failed jobs
// re-runs only the failed shards and every attempt's artifacts arrive together.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const SCRIPT = join(import.meta.dirname, 'e2e-shard-union.mjs');
const spec = (id) => ({ id, file: `${id}.spec.ts`, line: 1, tests: [{ projectId: 'default' }] });
const report = (ids, unexpected = 0) => ({
  stats: { expected: ids.length - unexpected, unexpected, flaky: 0, skipped: 0 },
  suites: [{ specs: ids.map(spec) }],
});

/** Runs the script over artifacts given as [name, ids the shard ran, unexpected count]. */
function union(artifacts, suite = ['a', 'b']) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-union-'));
  for (const [name, ids, unexpected] of artifacts) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'e2e.json'), JSON.stringify(report(ids, unexpected)));
    writeFileSync(join(dir, name, 'e2e-list.json'), JSON.stringify(report(suite)));
  }
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('one attempt, every shard green: passes', () => {
  const r = union([
    ['e2e-timings-1-1', ['a'], 0],
    ['e2e-timings-2-1', ['b'], 0],
  ]);
  assert.equal(r.status, 0, r.out);
});

test('a shard red on attempt 1 and green on attempt 2 passes; the other shard keeps attempt 1', () => {
  const r = union([
    ['e2e-timings-1-1', ['a'], 0],
    ['e2e-timings-2-1', ['b'], 1],
    ['e2e-timings-2-2', ['b'], 0],
  ]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /e2e-timings-2-2: 1 tests/);
  assert.doesNotMatch(r.out, /e2e-timings-2-1:/);
});

test('a shard still red on its highest attempt fails', () => {
  const r = union([
    ['e2e-timings-1-1', ['a'], 0],
    ['e2e-timings-2-1', ['b'], 0],
    ['e2e-timings-2-2', ['b'], 1],
  ]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /e2e-timings-2-2: 1 unexpected/);
});

test('attempt 10 outranks attempt 9', () => {
  const r = union([
    ['e2e-timings-1-9', ['a'], 1],
    ['e2e-timings-1-10', ['a'], 0],
    ['e2e-timings-2-1', ['b'], 0],
  ]);
  assert.equal(r.status, 0, r.out);
});

test('a missing shard fails: its tests are listed and in no report', () => {
  const r = union([['e2e-timings-1-1', ['a'], 0]]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /listed but in no shard/);
});

test('an artifact that is not a shard report fails', () => {
  const r = union([
    ['e2e-timings-1-1', ['a'], 0],
    ['e2e-timings-2-1', ['b'], 0],
    ['e2e-timings-3', ['b'], 0],
  ]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /not an e2e-timings-<shard>-<attempt> artifact/);
});

// ---- tests that passed only on a rerun ----

const HEADING = '## e2e tests that passed only on a rerun';
const TABLE_HEAD =
  '| Test | File | Shard | Failed on attempt | Passed on attempt |\n| --- | --- | --- | --- | --- |';
const NONE_LINE = 'No e2e test passed only on a rerun.';

/** A test definition: status per attempt is applied by `rich`. */
const T = (id, status, extra = {}) => ({
  id,
  status,
  title: `title of ${id}`,
  file: `${id}.spec.ts`,
  line: 1,
  projectId: 'default',
  describes: [],
  ...extra,
});

/** A Playwright-shaped report: file-level suites holding (nested) describe suites holding specs. */
function rich(tests) {
  const files = new Map();
  for (const t of tests) {
    if (!files.has(t.file))
      files.set(t.file, { title: t.file, file: t.file, specs: [], suites: [] });
    let suite = files.get(t.file);
    for (const d of t.describes) {
      let child = suite.suites.find((s) => s.title === d);
      if (!child) {
        child = { title: d, file: t.file, specs: [], suites: [] };
        suite.suites.push(child);
      }
      suite = child;
    }
    const same = suite.specs.find((s) => s.id === t.id);
    if (same) {
      same.tests.push({ projectId: t.projectId, status: t.status });
      continue;
    }
    suite.specs.push({
      id: t.id,
      title: t.title,
      file: t.file,
      line: t.line,
      tests: [{ projectId: t.projectId, status: t.status }],
    });
  }
  const count = (s) => tests.filter((t) => t.status === s).length;
  return {
    stats: {
      expected: count('expected'),
      unexpected: count('unexpected'),
      flaky: count('flaky'),
      skipped: count('skipped'),
    },
    suites: [...files.values()],
  };
}

/** [name, tests] for a readable attempt; [name, 'omit' | 'invalid'] for an unreadable e2e.json. */
function run(attempts, { summary, summaryPathOverride } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-union-th3-'));
  const cwd = mkdtempSync(join(tmpdir(), 'e2e-union-cwd-'));
  const seen = new Map();
  for (const [, tests] of attempts) {
    if (Array.isArray(tests))
      for (const t of tests) seen.set(`${t.id}/${t.projectId}`, { ...t, status: 'expected' });
  }
  const suite = rich([...seen.values()]);
  for (const [name, tests] of attempts) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'e2e-list.json'), JSON.stringify(suite));
    if (tests === 'invalid') writeFileSync(join(dir, name, 'e2e.json'), '{ not json');
    else if (tests === 'nostats')
      writeFileSync(join(dir, name, 'e2e.json'), JSON.stringify({ suites: suite.suites }));
    else if (tests !== 'omit')
      writeFileSync(join(dir, name, 'e2e.json'), JSON.stringify(rich(tests)));
  }
  const env = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  let summaryPath;
  if (summary !== undefined) {
    summaryPath = join(mkdtempSync(join(tmpdir(), 'e2e-union-sum-')), 'summary.md');
    writeFileSync(summaryPath, summary);
    env.GITHUB_STEP_SUMMARY = summaryPath;
  }
  if (summaryPathOverride !== undefined) env.GITHUB_STEP_SUMMARY = summaryPathOverride;
  const before = readdirSync(dir).sort().join(',');
  const r = spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', env, cwd });
  const lines = r.stdout.split('\n');
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    lines,
    passed: lines.filter((l) => l.startsWith('rerun-passed:')),
    warnings: lines.filter((l) => l.startsWith('::warning')),
    unreadable: lines.filter((l) => l.startsWith('rerun-unreadable:')),
    summary: summaryPath ? readFileSync(summaryPath, 'utf8') : undefined,
    dirChanged: before !== readdirSync(dir).sort().join(','),
    cwdEntries: readdirSync(cwd),
  };
}

const X = (status, extra) =>
  T('x', status, { file: 'a.spec.ts', line: 12, title: 'does x', ...extra });
const Y = (status = 'expected') => T('y', status, { file: 'y.spec.ts', line: 2, title: 'does y' });
const Z = (status = 'expected') => T('z', status, { file: 'z.spec.ts', line: 3, title: 'does z' });

/** x fails on attempts 1 and 3 (attempt 2 green), passes on 4; shard 2 is plain. */
const TWO_FAILS = () => [
  ['e2e-timings-1-1', [X('unexpected'), Y()]],
  ['e2e-timings-1-2', [X('expected'), Y()]],
  ['e2e-timings-1-3', [X('unexpected'), Y()]],
  ['e2e-timings-1-4', [X('expected'), Y()]],
  ['e2e-timings-2-1', [Z()]],
];
const LINE_X =
  'rerun-passed: client/e2e/a.spec.ts:12 shard 1 failed on attempt 1,3 passed on attempt 4: does x';

test('th-3.1: two failing attempts are both named in one line and the highest attempt is the passing one', () => {
  const r = run(TWO_FAILS());
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.passed, [LINE_X]);
});

test('th-3.1: a test that never failed, and tests of other shards, are not listed', () => {
  const r = run([
    ['e2e-timings-1-1', [X('unexpected'), Y()]],
    ['e2e-timings-1-2', [X('expected'), Y()]],
    ['e2e-timings-2-1', [Z()]],
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.passed, [
    'rerun-passed: client/e2e/a.spec.ts:12 shard 1 failed on attempt 1 passed on attempt 2: does x',
  ]);
});

test('th-3.1: attempt 10 is the passing attempt over attempt 9', () => {
  const r = run([
    ['e2e-timings-1-9', [X('unexpected')]],
    ['e2e-timings-1-10', [X('expected')]],
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.passed, [
    'rerun-passed: client/e2e/a.spec.ts:12 shard 1 failed on attempt 9 passed on attempt 10: does x',
  ]);
});

test('th-3.1: a nested describe title is joined with the spec title; a top-level spec has just its title', () => {
  const r = run([
    ['e2e-timings-1-1', [X('unexpected', { describes: ['outer', 'inner'] }), Y('unexpected')]],
    ['e2e-timings-1-2', [X('expected', { describes: ['outer', 'inner'] }), Y()]],
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.passed, [
    'rerun-passed: client/e2e/a.spec.ts:12 shard 1 failed on attempt 1 passed on attempt 2: outer › inner › does x',
    'rerun-passed: client/e2e/y.spec.ts:2 shard 1 failed on attempt 1 passed on attempt 2: does y',
  ]);
});

test('th-3.1: a flaky or skipped lower attempt is not a failure', () => {
  const r = run([
    ['e2e-timings-1-1', [X('flaky'), Y('skipped'), Z('expected')]],
    ['e2e-timings-1-2', [X('expected'), Y('expected'), Z('expected')]],
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.passed, []);
});

test('th-3.1: lines are ordered by shard, then file, then numeric line', () => {
  const at = (id, file, line, status) => T(id, status, { file, line, title: id });
  const lower = [
    at('p', 'b.spec.ts', 5, 'unexpected'),
    at('q', 'a.spec.ts', 30, 'unexpected'),
    at('r', 'a.spec.ts', 4, 'unexpected'),
  ];
  const upper = [
    at('p', 'b.spec.ts', 5, 'expected'),
    at('q', 'a.spec.ts', 30, 'expected'),
    at('r', 'a.spec.ts', 4, 'expected'),
  ];
  const s2lower = [at('s', 'a.spec.ts', 1, 'unexpected')];
  const s2upper = [at('s', 'a.spec.ts', 1, 'expected')];
  const r = run([
    ['e2e-timings-2-1', s2lower],
    ['e2e-timings-2-2', s2upper],
    ['e2e-timings-1-1', lower],
    ['e2e-timings-1-2', upper],
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.passed, [
    'rerun-passed: client/e2e/a.spec.ts:4 shard 1 failed on attempt 1 passed on attempt 2: r',
    'rerun-passed: client/e2e/a.spec.ts:30 shard 1 failed on attempt 1 passed on attempt 2: q',
    'rerun-passed: client/e2e/b.spec.ts:5 shard 1 failed on attempt 1 passed on attempt 2: p',
    'rerun-passed: client/e2e/a.spec.ts:1 shard 2 failed on attempt 1 passed on attempt 2: s',
  ]);
});

test("th-3.4: a test unexpected on its highest attempt fails the run and is not listed; another shard's rerun-pass still is", () => {
  const W = (status) => T('w', status, { file: 'w.spec.ts', line: 7, title: 'does w' });
  const r = run([
    ['e2e-timings-1-1', [X('expected')]],
    ['e2e-timings-1-2', [X('unexpected')]],
    ['e2e-timings-2-1', [W('unexpected')]],
    ['e2e-timings-2-2', [W('expected')]],
  ]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(r.passed, [
    'rerun-passed: client/e2e/w.spec.ts:7 shard 2 failed on attempt 1 passed on attempt 2: does w',
  ]);
  assert.equal(r.warnings.length, 1);
  assert.doesNotMatch(r.warnings[0], /does x/);
  assert.match(r.stderr, /e2e-timings-1-2: 1 unexpected/);
});

test('th-3.4: unexpected on every attempt up to the highest is never listed', () => {
  const r = run([
    ['e2e-timings-1-1', [X('unexpected')]],
    ['e2e-timings-1-2', [X('unexpected')]],
    ['e2e-timings-1-3', [X('unexpected')]],
  ]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(r.passed, []);
  assert.deepEqual(r.warnings, []);
});

test('th-3.4: within one shard a rerun-passed test is listed and the still-failing one is not', () => {
  const r = run([
    ['e2e-timings-1-1', [X('unexpected'), Y('expected')]],
    ['e2e-timings-1-2', [X('expected'), Y('unexpected')]],
  ]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(r.passed, [
    'rerun-passed: client/e2e/a.spec.ts:12 shard 1 failed on attempt 1 passed on attempt 2: does x',
  ]);
});

test('th-3.4: a test flaky on its highest attempt is not listed and the run fails', () => {
  const r = run([
    ['e2e-timings-1-1', [X('unexpected')]],
    ['e2e-timings-1-2', [X('flaky')]],
  ]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(r.passed, []);
  assert.deepEqual(r.warnings, []);
});

const ROW_X = '| does x | `client/e2e/a.spec.ts:12` | 1 | 1, 3 | 4 |';

test('th-3.2: the summary gets the heading, the table head and one exact row, appended after existing content', () => {
  const seed = 'earlier step output\n';
  const r = run(TWO_FAILS(), { summary: seed });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.summary.startsWith(seed), r.summary);
  assert.equal(r.summary.slice(seed.length).trim(), `${HEADING}\n\n${TABLE_HEAD}\n${ROW_X}`);
});

test('th-3.2: rows follow the listing order, one per test', () => {
  const r = run(
    [
      ['e2e-timings-1-1', [X('unexpected'), Y('unexpected')]],
      ['e2e-timings-1-2', [X('expected'), Y('expected')]],
      ['e2e-timings-2-1', [Z('unexpected')]],
      ['e2e-timings-2-2', [Z('expected')]],
    ],
    { summary: '' },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(
    r.summary.trim(),
    [
      HEADING,
      '',
      TABLE_HEAD,
      '| does x | `client/e2e/a.spec.ts:12` | 1 | 1 | 2 |',
      '| does y | `client/e2e/y.spec.ts:2` | 1 | 1 | 2 |',
      '| does z | `client/e2e/z.spec.ts:3` | 2 | 1 | 2 |',
    ].join('\n'),
  );
});

test('th-3.2: a run that exits 1 for an existing rule still writes the table', () => {
  const r = run([...TWO_FAILS().slice(0, 4), ['e2e-timings-2-1', [Z('unexpected')]]], {
    summary: 'seed\n',
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.summary.startsWith('seed\n'));
  assert.equal(r.summary.slice('seed\n'.length).trim(), `${HEADING}\n\n${TABLE_HEAD}\n${ROW_X}`);
});

test('th-3.2: with no qualifying test the summary says so, on a clean run and on a failing run', () => {
  const clean = run([['e2e-timings-1-1', [X('expected')]]], { summary: 'seed\n' });
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.ok(clean.summary.startsWith('seed\n'));
  assert.equal(clean.summary.slice('seed\n'.length).trim(), `${HEADING}\n\n${NONE_LINE}`);
  const failing = run([['e2e-timings-1-1', [X('unexpected')]]], { summary: '' });
  assert.equal(failing.status, 1);
  assert.equal(failing.summary.trim(), `${HEADING}\n\n${NONE_LINE}`);
});

test('th-3.2: a pipe in a title is escaped so the row keeps five cells', () => {
  const r = run(
    [
      ['e2e-timings-1-1', [X('unexpected', { title: 'a | b' })]],
      ['e2e-timings-1-2', [X('expected', { title: 'a | b' })]],
    ],
    { summary: '' },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.summary.includes('| a \\| b | `client/e2e/a.spec.ts:12` | 1 | 1 | 2 |'), r.summary);
});

test('th-3.2: with GITHUB_STEP_SUMMARY unset no summary file is created anywhere', () => {
  const r = run(TWO_FAILS());
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.dirChanged, false);
  assert.deepEqual(r.cwdEntries, []);
});

test('th-3.3: one warning per listed test with the repository path, line and title in the message', () => {
  const r = run(TWO_FAILS());
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.warnings, [
    '::warning file=client/e2e/a.spec.ts,line=12,title=Passed only on a rerun::does x (shard 1, failed on attempt 1,3, passed on attempt 4)',
  ]);
});

test('th-3.3: a nested describe title is in the warning message', () => {
  const r = run([
    ['e2e-timings-1-1', [X('unexpected', { describes: ['outer', 'inner'] })]],
    ['e2e-timings-1-2', [X('expected', { describes: ['outer', 'inner'] })]],
  ]);
  assert.deepEqual(r.warnings, [
    '::warning file=client/e2e/a.spec.ts,line=12,title=Passed only on a rerun::outer › inner › does x (shard 1, failed on attempt 1, passed on attempt 2)',
  ]);
});

// Titles are normalised to one line before escaping, so only '%' needs escaping here.
test('th-3.3: percent in a title is escaped in the message and a line break becomes one space', () => {
  const title = '100% sure\r\nsecond';
  const r = run([
    ['e2e-timings-1-1', [X('unexpected', { title })]],
    ['e2e-timings-1-2', [X('expected', { title })]],
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.warnings, [
    '::warning file=client/e2e/a.spec.ts,line=12,title=Passed only on a rerun::100%25 sure second (shard 1, failed on attempt 1, passed on attempt 2)',
  ]);
});

test('th-3.3: a run with no rerun-passed test prints no warning', () => {
  const r = run([['e2e-timings-1-1', [X('expected')]]]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.warnings, []);
});

test('th-3.5: a lower attempt with no e2e.json is named unreadable and does not fail the run', () => {
  const r = run([
    ['e2e-timings-1-1', 'omit'],
    ['e2e-timings-1-2', [X('expected')]],
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.unreadable, ['rerun-unreadable: e2e-timings-1-1: no readable e2e.json']);
  assert.deepEqual(r.passed, []);
});

test('th-3.5: a lower attempt whose e2e.json is not valid JSON is named unreadable and does not fail the run', () => {
  const r = run([
    ['e2e-timings-1-1', 'invalid'],
    ['e2e-timings-1-2', [X('expected')]],
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.unreadable, ['rerun-unreadable: e2e-timings-1-1: no readable e2e.json']);
});

test('th-3.5: each unreadable lower attempt is named and the readable lower attempts still count', () => {
  const r = run([
    ['e2e-timings-1-1', 'omit'],
    ['e2e-timings-1-2', [X('unexpected')]],
    ['e2e-timings-1-3', 'invalid'],
    ['e2e-timings-1-4', [X('expected')]],
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.unreadable, [
    'rerun-unreadable: e2e-timings-1-1: no readable e2e.json',
    'rerun-unreadable: e2e-timings-1-3: no readable e2e.json',
  ]);
  assert.deepEqual(r.passed, [
    'rerun-passed: client/e2e/a.spec.ts:12 shard 1 failed on attempt 2 passed on attempt 4: does x',
  ]);
});

test('th-3.5: the summary names each unreadable lower attempt after the no-test line', () => {
  const r = run(
    [
      ['e2e-timings-1-1', 'omit'],
      ['e2e-timings-1-2', 'invalid'],
      ['e2e-timings-1-3', [X('expected')]],
    ],
    { summary: '' },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // Blank-line placement between the no-test line and the Unreadable lines is not pinned.
  assert.deepEqual(
    r.summary.split('\n').filter((l) => l.trim() !== ''),
    [
      HEADING,
      NONE_LINE,
      'Unreadable: e2e-timings-1-1 had no readable e2e.json.',
      'Unreadable: e2e-timings-1-2 had no readable e2e.json.',
    ],
  );
});

test('th-3.5: a highest attempt with no e2e.json still fails the run', () => {
  const r = run([
    ['e2e-timings-1-1', [X('expected')]],
    ['e2e-timings-1-2', 'omit'],
  ]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /e2e-timings-1-2: e2e.json or e2e-list.json is missing/);
});

// ---- shard order, project keys, one-line titles, unreadable highest attempts, summary write failures ----

const STDERR_UNREADABLE =
  'e2e-shard-union: e2e-timings-1-2: e2e.json or e2e-list.json is missing or unreadable';

test('th-3.1: shard 2 is listed before shard 10 (numeric shard order)', () => {
  const r = run([
    ['e2e-timings-10-1', [X('unexpected')]],
    ['e2e-timings-10-2', [X('expected')]],
    ['e2e-timings-2-1', [Z('unexpected')]],
    ['e2e-timings-2-2', [Z('expected')]],
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.passed, [
    'rerun-passed: client/e2e/z.spec.ts:3 shard 2 failed on attempt 1 passed on attempt 2: does z',
    'rerun-passed: client/e2e/a.spec.ts:12 shard 10 failed on attempt 1 passed on attempt 2: does x',
  ]);
});

test('th-3.1: a test is keyed by spec and project: one failing project passing on rerun is one line', () => {
  const P = (status, projectId) => X(status, { projectId });
  const r = run([
    ['e2e-timings-1-1', [P('unexpected', 'default'), P('expected', 'reduced-motion')]],
    ['e2e-timings-1-2', [P('expected', 'default'), P('expected', 'reduced-motion')]],
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.passed, [
    'rerun-passed: client/e2e/a.spec.ts:12 shard 1 failed on attempt 1 passed on attempt 2: does x',
  ]);
});

test('th-3.1: a project that is unexpected on both attempts is not listed because its sibling project passed', () => {
  const P = (status, projectId) => X(status, { projectId });
  const r = run([
    ['e2e-timings-1-1', [P('expected', 'default'), P('unexpected', 'reduced-motion')]],
    ['e2e-timings-1-2', [P('expected', 'default'), P('unexpected', 'reduced-motion')]],
  ]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(r.passed, []);
  assert.deepEqual(r.warnings, []);
});

test('th-3.4: unexpected on attempt 1 and skipped on the highest attempt is not listed', () => {
  const r = run([
    ['e2e-timings-1-1', [X('unexpected')]],
    ['e2e-timings-1-2', [X('skipped')]],
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.passed, []);
  assert.deepEqual(r.warnings, []);
});

test('th-3.4: a test unexpected on a lower attempt and absent from the highest report is not listed and does not crash', () => {
  const r = run([
    ['e2e-timings-1-1', [X('unexpected'), Y()]],
    ['e2e-timings-1-2', [Y()]],
  ]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(r.passed, []);
  assert.deepEqual(r.warnings, []);
  assert.doesNotMatch(r.stderr, /TypeError/);
});

test('th-3.1: line breaks in a title become one space each in the rerun-passed line', () => {
  for (const [raw, flat] of [
    ['first\nsecond', 'first second'],
    ['first\r\nsecond', 'first second'],
  ]) {
    const r = run([
      ['e2e-timings-1-1', [X('unexpected', { title: raw })]],
      ['e2e-timings-1-2', [X('expected', { title: raw })]],
    ]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.passed, [
      `rerun-passed: client/e2e/a.spec.ts:12 shard 1 failed on attempt 1 passed on attempt 2: ${flat}`,
    ]);
  }
});

test('th-3.3: line breaks in a title become spaces in the warning, with no %0A or %0D', () => {
  for (const [raw, flat] of [
    ['first\nsecond', 'first second'],
    ['first\r\nsecond', 'first second'],
  ]) {
    const r = run([
      ['e2e-timings-1-1', [X('unexpected', { title: raw })]],
      ['e2e-timings-1-2', [X('expected', { title: raw })]],
    ]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(r.warnings, [
      `::warning file=client/e2e/a.spec.ts,line=12,title=Passed only on a rerun::${flat} (shard 1, failed on attempt 1, passed on attempt 2)`,
    ]);
    assert.doesNotMatch(r.stdout, /%0[AD]/);
  }
});

test('th-3.2: line breaks in a title become spaces in the summary row', () => {
  const r = run(
    [
      ['e2e-timings-1-1', [X('unexpected', { title: 'first\r\nsecond\nthird' })]],
      ['e2e-timings-1-2', [X('expected', { title: 'first\r\nsecond\nthird' })]],
    ],
    { summary: '' },
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(
    r.summary.trim(),
    `${HEADING}\n\n${TABLE_HEAD}\n| first second third | \`client/e2e/a.spec.ts:12\` | 1 | 1 | 2 |`,
  );
});

test('th-3.2: an unwritable step summary path warns on stderr and does not fail a green run', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'e2e-union-nodir-')), 'absent', 'summary.md');
  const r = run(TWO_FAILS(), { summaryPathOverride: missing });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.passed, [LINE_X]);
  assert.ok(
    r.stderr
      .split('\n')
      .some((l) => l.startsWith('e2e-shard-union: cannot write the step summary')),
    r.stderr,
  );
});

test('th-3.2: a highest attempt whose e2e.json is not valid JSON fails the run and the summary is still written', () => {
  const r = run(
    [
      ['e2e-timings-1-1', [X('expected')]],
      ['e2e-timings-1-2', 'invalid'],
    ],
    { summary: '' },
  );
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.stderr.split('\n').includes(STDERR_UNREADABLE), r.stderr);
  assert.equal(r.summary.split('\n')[0], HEADING);
});

test('th-3.2: a highest attempt whose e2e.json has no stats fails the run and the summary is still written', () => {
  const r = run(
    [
      ['e2e-timings-1-1', [X('expected')]],
      ['e2e-timings-1-2', 'nostats'],
    ],
    { summary: '' },
  );
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.stderr.split('\n').includes(STDERR_UNREADABLE), r.stderr);
  assert.equal(r.summary.split('\n')[0], HEADING);
});

test('th-3.3: a file name with a comma, colon and percent is escaped in file= and raw in the listing', () => {
  const file = 'a,b:c%d.spec.ts';
  const r = run([
    ['e2e-timings-1-1', [X('unexpected', { file })]],
    ['e2e-timings-1-2', [X('expected', { file })]],
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.warnings, [
    '::warning file=client/e2e/a%2Cb%3Ac%25d.spec.ts,line=12,title=Passed only on a rerun::does x (shard 1, failed on attempt 1, passed on attempt 2)',
  ]);
  assert.deepEqual(r.passed, [
    'rerun-passed: client/e2e/a,b:c%d.spec.ts:12 shard 1 failed on attempt 1 passed on attempt 2: does x',
  ]);
});

test('th-3.5: unreadable lower attempts are named ascending by shard then attempt', () => {
  const r = run([
    ['e2e-timings-2-2', 'invalid'],
    ['e2e-timings-2-3', [Z()]],
    ['e2e-timings-1-3', 'omit'],
    ['e2e-timings-1-1', 'omit'],
    ['e2e-timings-1-4', [X('expected')]],
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.unreadable, [
    'rerun-unreadable: e2e-timings-1-1: no readable e2e.json',
    'rerun-unreadable: e2e-timings-1-3: no readable e2e.json',
    'rerun-unreadable: e2e-timings-2-2: no readable e2e.json',
  ]);
});
