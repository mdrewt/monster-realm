// The justfile `ci:` recipe is the merge gate; .github/workflows/ci.yml runs its recipes one per
// step across parallel jobs. A recipe listed in `ci:` with no workflow step would leave the
// workflow green with that gate gone.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

// The dependency list of the justfile `ci:` recipe.
function ciRecipes(justfile) {
  const line = justfile.split('\n').find((l) => l.startsWith('ci:'));
  assert.ok(line, 'justfile has no `ci:` recipe');
  return line.slice('ci:'.length).trim().split(/\s+/);
}

// Recipes the workflow runs as a single-line `run: just [--no-deps] <recipe>` step.
function workflowRecipes(workflow) {
  const found = new Set();
  for (const line of workflow.split('\n')) {
    const m = /^\s*(?:-\s+)?run:\s+just\s+(?:--no-deps\s+)?([\w-]+)\s*(?:#.*)?$/.exec(line);
    if (m) found.add(m[1]);
  }
  return found;
}

const missing = (justfile, workflow) => {
  const ran = workflowRecipes(workflow);
  return ciRecipes(justfile).filter((r) => !ran.has(r));
};

test('every recipe of the justfile `ci:` recipe runs as a step of ci.yml', () => {
  const recipes = ciRecipes(read('justfile'));
  assert.ok(recipes.length > 0, 'ci: lists no recipes');
  assert.deepEqual(missing(read('justfile'), read('.github/workflows/ci.yml')), []);
});

test('a recipe that is absent, commented out, or only a prefix of a step is reported missing', () => {
  const justfile = 'ci: lint test client-test\n';
  const workflow = [
    '      - run: just lint',
    '      # - run: just test',
    '      - run: just --no-deps client-test # pkg already built',
  ].join('\n');
  assert.deepEqual(missing(justfile, workflow), ['test']);
  assert.deepEqual(missing(justfile, `${workflow}\n      - run: just test-all`), ['test']);
  assert.deepEqual(missing(justfile, `${workflow}\n      - run: just test`), []);
});

// A job that fetches a tool release itself fails whenever the release host does. Every job gets
// its tools from .github/actions/tools, which serves them from cache.
const jobs = (workflow) =>
  workflow
    .slice(workflow.indexOf('\njobs:\n'))
    .split(/\n(?=  [\w-]+:\n)/)
    .slice(1)
    .map((body) => ({ name: body.slice(2, body.indexOf(':')), body }));

const TOOL = /\b(just|wasm-pack|spacetime)\s/;
const usesTool = (body) => body.split('\n').some((l) => !l.trim().startsWith('#') && TOOL.test(l));
const jobsWithoutTools = (workflow) =>
  jobs(workflow)
    .filter(
      ({ body }) => usesTool(body) && !/^\s+- uses: \.\/\.github\/actions\/tools$/m.test(body),
    )
    .map(({ name }) => name);

for (const file of ['ci.yml', 'nightly.yml']) {
  test(`every ${file} job that runs just, wasm-pack or spacetime takes them from the tools action`, () => {
    const workflow = read(`.github/workflows/${file}`);
    assert.ok(
      jobs(workflow).some(({ body }) => usesTool(body)),
      'no job runs a tool',
    );
    assert.deepEqual(jobsWithoutTools(workflow), []);
  });
}

test('a job that runs a tool without the tools action is reported', () => {
  const workflow = [
    'jobs:',
    '  good:',
    '    steps:',
    '      - uses: ./.github/actions/tools',
    '      - run: just lint',
    '  commented:',
    '    steps:',
    '      # - uses: ./.github/actions/tools',
    '      - run: spacetime start',
    '  no-tool:',
    '    steps:',
    '      # just a comment',
    '      - run: node scripts/e2e-shard-union.mjs e2e-shards',
  ].join('\n');
  assert.deepEqual(jobsWithoutTools(`name: x\n${workflow}`), ['commented']);
});

// Jobs that share a wasm-pack download cache key overwrite nothing: the first to finish writes it
// and the rest restore it. A `--dev` build (`just eval`) downloads no binaryen, so a key shared
// with a release build (`just wasm`) can hold a directory the release build still has to fill
// from the network on every run. Each job therefore keys the directory by its own job id.
const sharedCacheKeys = (action) =>
  action
    .split('\n')
    .filter((l) => /^\s+(key|restore-keys):\s+wasm-pack-downloads-/.test(l))
    .filter((l) => !/-\$\{\{ github\.job \}\}-/.test(l))
    .map((l) => l.trim().split(':')[0]);

test('the wasm-pack download cache is keyed by job, on both key and restore-keys', () => {
  const action = read('.github/actions/tools/action.yml');
  const keyed = action.split('\n').filter((l) => l.includes(': wasm-pack-downloads-'));
  assert.equal(keyed.length, 2, 'expected one key and one restore-keys line');
  assert.deepEqual(sharedCacheKeys(action), []);
});

test('a wasm-pack download cache key without the job id is reported', () => {
  const expr = (e) => ['$', `{{ ${e} }}`].join('');
  const prefix = `wasm-pack-downloads-${expr('runner.os')}-${expr('runner.arch')}-`;
  const action = [
    `        key: ${prefix}${expr("hashFiles('Cargo.lock')")}`,
    `        restore-keys: ${prefix}${expr('github.job')}-`,
  ].join('\n');
  assert.deepEqual(sharedCacheKeys(action), ['key']);
  assert.deepEqual(sharedCacheKeys(action.replace('restore-keys', 'key')), ['key']);
  assert.deepEqual(sharedCacheKeys(action.replace(prefix, `${prefix}${expr('github.job')}-`)), []);
});
