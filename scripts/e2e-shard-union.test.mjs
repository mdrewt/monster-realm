// e2e-shard-union.mjs judges each shard by its highest run attempt: a re-run of failed jobs
// re-runs only the failed shards and every attempt's artifacts arrive together.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
