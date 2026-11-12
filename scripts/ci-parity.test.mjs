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
