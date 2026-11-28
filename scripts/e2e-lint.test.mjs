// e2e-lint.mjs: a per-file ratchet on fixed waits and hard-coded ports in client/e2e.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const SCRIPT = join(import.meta.dirname, 'e2e-lint.mjs');

/** A throwaway repo root holding client/e2e/<name> files and an optional baseline. */
function repo(files, baseline) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-lint-'));
  mkdirSync(join(root, 'client', 'e2e'), { recursive: true });
  mkdirSync(join(root, 'scripts'));
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(root, 'client', 'e2e', name), text);
  if (baseline)
    writeFileSync(join(root, 'scripts', 'e2e-lint.baseline.json'), JSON.stringify(baseline));
  return root;
}
const run = (root, ...extra) => {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...extra], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
};
const EMPTY = { wait: {}, port: {} };

test('a clean suite at an empty baseline passes', () => {
  const r = run(repo({ 'a.spec.ts': "await expect(page.locator('#x')).toBeVisible();\n" }, EMPTY));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /E2E-LINT-OK wait=0 port=0/);
});

test('a new waitForTimeout fails and names the line', () => {
  const r = run(repo({ 'a.spec.ts': 'x();\nawait page.waitForTimeout(500);\n' }, EMPTY));
  assert.equal(r.status, 1);
  assert.match(r.out, /client\/e2e\/a\.spec\.ts:2 {2}await page\.waitForTimeout\(500\)/);
});

test('bare sleep( and setTimeout( calls count as waits; their definitions do not', () => {
  const src = [
    'function sleep(ms) {',
    '  return new Promise((done) => setTimeout(done, ms));',
    '}',
    'await sleep(100);',
  ].join('\n');
  const r = run(repo({ 'a.spec.ts': src }, EMPTY));
  assert.equal(r.status, 1);
  assert.match(r.out, /a\.spec\.ts: 2 wait line\(s\), baseline 0/);
});

test('test.setTimeout and socket.setTimeout are timeouts, not delays', () => {
  const src = 'test.setTimeout(60_000);\nsocket.setTimeout(1_000);\n';
  assert.equal(run(repo({ 'a.spec.ts': src }, EMPTY)).status, 0);
});

test('a hard-coded host:port fails as a port finding', () => {
  const r = run(repo({ 'a.spec.ts': "const u = 'ws://127.0.0.1:3000';\n" }, EMPTY));
  assert.equal(r.status, 1);
  assert.match(r.out, /1 port line\(s\), baseline 0/);
});

test('an e2e-lint-ok reason on the line or the line above exempts it; a bare marker does not', () => {
  const ok = [
    'await page.waitForTimeout(300); // e2e-lint-ok: nothing may happen for 3 steps',
    '// e2e-lint-ok: the absence of a move is the assertion',
    'await page.waitForTimeout(300);',
  ].join('\n');
  assert.equal(run(repo({ 'a.spec.ts': ok }, EMPTY)).status, 0);
  const bare = 'await page.waitForTimeout(300); // e2e-lint-ok:\n';
  assert.equal(run(repo({ 'a.spec.ts': bare }, EMPTY)).status, 1);
});

test('comment-only lines are not counted', () => {
  const src = '// we used to page.waitForTimeout(500) at localhost:3000 here\n * sleep(1)\n';
  assert.equal(run(repo({ 'a.spec.ts': src }, EMPTY)).status, 0);
});

test('a file at its baseline passes; one more than baseline fails', () => {
  const base = { wait: { 'client/e2e/a.spec.ts': 1 }, port: {} };
  const one = 'await page.waitForTimeout(1);\n';
  assert.equal(run(repo({ 'a.spec.ts': one }, base)).status, 0);
  assert.equal(run(repo({ 'a.spec.ts': one + one }, base)).status, 1);
});

test('the allowance is per file: a wait moved into another file fails', () => {
  const base = { wait: { 'client/e2e/a.spec.ts': 1 }, port: {} };
  const r = run(repo({ 'a.spec.ts': 'x();\n', 'b.spec.ts': 'await sleep(5);\n' }, base));
  assert.equal(r.status, 1);
  assert.match(r.out, /b\.spec\.ts: 1 wait line\(s\), baseline 0/);
});

test('below baseline fails with the ratchet hint, and --write-baseline lowers it', () => {
  const base = { wait: { 'client/e2e/a.spec.ts': 2 }, port: {} };
  const root = repo({ 'a.spec.ts': 'await page.waitForTimeout(1);\n' }, base);
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.out, /RATCHET/);
  assert.equal(run(root, '--write-baseline').status, 0);
  const written = JSON.parse(readFileSync(join(root, 'scripts', 'e2e-lint.baseline.json'), 'utf8'));
  assert.deepEqual(written.wait, { 'client/e2e/a.spec.ts': 1 });
  assert.equal(run(root).status, 0);
});

test('--write-baseline refuses to raise a count', () => {
  const root = repo({ 'a.spec.ts': 'await sleep(1);\n' }, EMPTY);
  const r = run(root, '--write-baseline');
  assert.equal(r.status, 1);
  assert.match(r.out, /never raises a count/);
});

test('files in subdirectories of client/e2e are scanned', () => {
  const root = repo({}, EMPTY);
  mkdirSync(join(root, 'client', 'e2e', 'helpers'));
  writeFileSync(join(root, 'client', 'e2e', 'helpers', 'h.ts'), 'await sleep(1);\n');
  assert.equal(run(root).status, 1);
});

test('no baseline file fails closed', () => {
  const r = run(repo({ 'a.spec.ts': 'x();\n' }));
  assert.equal(r.status, 1);
  assert.match(r.out, /no baseline/);
});
