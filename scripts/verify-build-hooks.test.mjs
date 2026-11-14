// Unit tests for the built-bundle checker (just playtest-verify-build / client-verify-build): a
// broken matcher would let a DEV window hook ship in a release build, and a broken shell-config
// check would pass a build that points players at the wrong database (or bakes the database name
// into a bundle, where a host cannot change it).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEV_HOOK_FINGERPRINTS, findDevHooks } from './verify-build-hooks.mjs';

const flagged = (bundle) => findDevHooks(bundle, DEV_HOOK_FINGERPRINTS).length > 0;

test('findDevHooks flags every DEV hook in assignment and defineProperty form', () => {
  for (const hook of ['__game', '__mrTrade', '__mrPvp']) {
    for (const bundle of [
      `w.${hook}=1;`,
      `window.${hook} = function(){};`,
      `Object.defineProperty(window,"${hook}",{value:fn})`,
      `Object.defineProperty(window,'${hook}',{value:fn})`,
    ]) {
      assert.ok(flagged(bundle), `not flagged: ${bundle}`);
    }
  }
});

test('findDevHooks ignores clean code, dead literals, comment tokens and the __mrBuild stamp', () => {
  for (const bundle of [
    'var a=function(e,t){return e+t};export{a as add};',
    '/* __mrPvp __game debug tokens */\nvar hooks={challengePvp:function(){},proposeTrade:function(){}};\nexport{hooks};',
    "window.__mrBuild = {sha:'abc123',time:'2026-07-19'};",
  ]) {
    assert.deepEqual(findDevHooks(bundle, DEV_HOOK_FINGERPRINTS), [], bundle);
  }
});

// bt-12 B (BT12.5, plan §2.11 + REV B2.10): the DEV-gated `__mrTactics` e2e hook joins the set, in
// the two binding forms, the two defineProperty forms AND the bare name (the only shape that catches
// `Object.assign(window, { __mrTactics })` or a bracket write; the name occurs nowhere else).
// WRONG IMPL KILLED: the hook left out of DEV_HOOK_FINGERPRINTS (a release build ships a read-only
// window into battle state); only the `.x=` form added (a pretty build's `window.__mrTactics = …` or
// a defineProperty escape ships); the bare form missing (an Object.assign / bracket write ships);
// a bare form so broad it flags the ungated `__mrBuild` stamp.
test('findDevHooks flags the __mrTactics hook in assignment, defineProperty, Object.assign and bracket form, and still passes a clean bundle with the __mrBuild stamp', () => {
  for (const bundle of [
    'w.__mrTactics=1;',
    'window.__mrTactics = function(){};',
    'Object.defineProperty(window,"__mrTactics",{value:fn})',
    "Object.defineProperty(window,'__mrTactics',{value:fn})",
    'Object.assign(window,{__mrTactics:t});',
    'Object.assign(window, { __mrTactics });',
    'window["__mrTactics"]=t;',
  ]) {
    assert.ok(flagged(bundle), `not flagged: ${bundle}`);
  }
  for (const bundle of [
    "window.__mrBuild = {sha:'abc123',time:'2026-11-01'};",
    'var tactics={battle:function(){},ownMonsters:function(){}};export{tactics};',
  ]) {
    assert.deepEqual(findDevHooks(bundle, DEV_HOOK_FINGERPRINTS), [], bundle);
  }
});

// --- the command line over real build directories -------------------------------------------
//
// Each case writes a build directory under the OS temp dir, runs the CLI on it with
// MR_PLAYTEST_DB set to a name other than the CLI's default (so a hardcoded default fails), and
// removes the directory afterwards.

const SCRIPT = fileURLToPath(new URL('./verify-build-hooks.mjs', import.meta.url));
const DB = 'realm-trial-7';
const OTHER_DB = 'realm-trial-8';

const shellConfig = (db) =>
  `globalThis.__MR_SHELL_CONFIG__={"connection":{"uri":"ws://127.0.0.1:3000","db":"${db}","kind":"test"}};`;

/** The minimal passing build: only `shell-config.js` names the database. */
const minimalBuild = () => ({
  'index.html':
    '<!doctype html><html><body><script src="/shell-config.js"></script>' +
    '<script type="module" src="/assets/app.js"></script></body></html>',
  'assets/app.js': 'var a=function(e,t){return e+t};export{a as add};',
  'shell-config.js': shellConfig(DB),
});

/** Write `files` (relative path -> text; `undefined` omits it) into a fresh dir, run the CLI on it
 *  and remove the dir. An `env` key set to `undefined` is left out of the child's environment. */
function runOn(files, env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verify-build-hooks-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      if (text === undefined) continue;
      const full = path.join(dir, rel);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
    const childEnv = { ...process.env, MR_PLAYTEST_DB: DB, ...env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete childEnv[key];
    }
    const res = spawnSync(process.execPath, [SCRIPT, dir], {
      env: childEnv,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Assert a failing run: exit status 1, every stderr line prefixed, and each `needle` named. */
function assertFails(res, needles, what) {
  assert.equal(res.status, 1, `${what}: exit 1 (stdout ${res.stdout} / stderr ${res.stderr})`);
  const lines = res.stderr.split('\n').filter((l) => l.trim() !== '');
  assert.ok(lines.length > 0, `${what}: stderr explains the failure`);
  for (const line of lines) {
    assert.ok(line.startsWith('verify-build-hooks:'), `${what}: stderr line ${line}`);
  }
  assert.ok(!res.stdout.includes('verify-build-hooks: OK'), `${what}: no OK line`);
  for (const needle of needles) {
    assert.ok(res.stderr.includes(needle), `${what}: stderr names ${needle}: ${res.stderr}`);
  }
}

test('the CLI passes a build where only shell-config.js names the playtest database', () => {
  const res = runOn(minimalBuild());
  assert.equal(res.status, 0, `exit 0 (stderr ${res.stderr})`);
  assert.ok(res.stdout.startsWith('verify-build-hooks: OK'), res.stdout);
});

test('the CLI fails a build without shell-config.js, naming it', () => {
  assertFails(
    runOn({ ...minimalBuild(), 'shell-config.js': undefined }),
    ['shell-config.js'],
    'missing',
  );
});

test('the CLI fails a shell-config.js that sets no readable document, naming the page global', () => {
  const cases = [
    ['it throws', 'throw new Error("no config");'],
    ['it sets nothing', 'var unused = 1;'],
    ['it sets a non-object', 'globalThis.__MR_SHELL_CONFIG__ = 7;'],
    ['it sets no connection', 'globalThis.__MR_SHELL_CONFIG__ = {};'],
    [
      'its db is not a string',
      'globalThis.__MR_SHELL_CONFIG__={"connection":{"uri":"ws://127.0.0.1:3000","db":7}};',
    ],
    ['it never finishes', 'for (;;) {}'],
    [
      'it replaces JSON.stringify before setting a document',
      `JSON.stringify = () => 'nope'; globalThis.__MR_SHELL_CONFIG__ = {"connection":{"uri":"ws://127.0.0.1:3000","db":"${DB}"}};`,
    ],
    ['it throws a value whose toString never returns', 'throw { toString() { for (;;) {} } };'],
    [
      'it throws a proxy whose prototype lookup never returns',
      'throw new Proxy({}, { getPrototypeOf() { for (;;) {} } });',
    ],
  ];
  for (const [what, text] of cases) {
    assertFails(
      runOn({ ...minimalBuild(), 'shell-config.js': text }),
      ['__MR_SHELL_CONFIG__'],
      what,
    );
  }
});

test('the CLI fails a shell-config.js naming another database, naming both', () => {
  const res = runOn({ ...minimalBuild(), 'shell-config.js': shellConfig(OTHER_DB) });
  assertFails(res, [OTHER_DB, DB], 'another database');
});

test('the CLI fails when any other file in the build names the database, naming that file', () => {
  const cases = [
    ['a bundle', path.join('assets', 'leak.js'), `var d="${DB}";`],
    ['a nested shell-config.js', path.join('assets', 'shell-config.js'), shellConfig(DB)],
    ['a non-js asset', path.join('assets', 'data.json'), `{"db":"${DB}"}`],
  ];
  for (const [what, rel, text] of cases) {
    assertFails(runOn({ ...minimalBuild(), [rel]: text }), [rel], what);
  }
  const html = `${minimalBuild()['index.html']}<!-- ${DB} -->`;
  assertFails(runOn({ ...minimalBuild(), 'index.html': html }), ['index.html'], 'index.html');
});

test('the CLI fails a build whose index.html is missing or does not load /shell-config.js', () => {
  assertFails(runOn({ ...minimalBuild(), 'index.html': undefined }), ['index.html'], 'missing');
  const noScript =
    '<!doctype html><html><body><script type="module" src="/assets/app.js"></script></body></html>';
  assertFails(runOn({ ...minimalBuild(), 'index.html': noScript }), ['index.html'], 'no script');
});

test('the CLI fails a build with no bundle besides shell-config.js, or no directory at all', () => {
  assertFails(runOn({ ...minimalBuild(), 'assets/app.js': undefined }), [], 'no bundle');
  const gone = path.join(os.tmpdir(), `verify-build-hooks-absent-${process.pid}`);
  const res = spawnSync(process.execPath, [SCRIPT, gone], {
    env: { ...process.env, MR_PLAYTEST_DB: DB },
    encoding: 'utf8',
  });
  assertFails({ status: res.status, stdout: res.stdout, stderr: res.stderr }, [], 'no directory');
});

test('the CLI fails when MR_PLAYTEST_DB is blank or the development database, even with a matching shell config', () => {
  for (const db of ['   ', 'monster-realm', 'Monster-Realm', 'MONSTER-REALM']) {
    const res = runOn(
      { ...minimalBuild(), 'shell-config.js': shellConfig(db.trim()) },
      { MR_PLAYTEST_DB: db },
    );
    assertFails(res, [], `MR_PLAYTEST_DB ${JSON.stringify(db)}`);
  }
});

test('the CLI still fails a DEV hook in a bundle when the shell config beside it is valid', () => {
  const res = runOn({ ...minimalBuild(), 'assets/app.js': 'window.__game = function(){};' });
  assertFails(res, ['__game'], 'dev hook');
});

test('the CLI fails a DEV hook in a .js file at the root of the build', () => {
  const res = runOn({ ...minimalBuild(), 'x.js': 'window.__game = function(){};' });
  assertFails(res, ['__game'], 'root dev hook');
});

test('the CLI compares the shell config`s database to MR_PLAYTEST_DB exactly', () => {
  for (const named of [`${DB}-old`, DB.slice(0, -1), DB.toUpperCase()]) {
    const res = runOn({ ...minimalBuild(), 'shell-config.js': shellConfig(named) });
    assertFails(res, [DB], `shell config names ${JSON.stringify(named)}`);
  }
});

test('the CLI defaults MR_PLAYTEST_DB to monster-realm-playtest and trims a set value', () => {
  const defaultBuild = {
    ...minimalBuild(),
    'shell-config.js': shellConfig('monster-realm-playtest'),
  };
  const unset = { MR_PLAYTEST_DB: undefined };
  const passing = runOn(defaultBuild, unset);
  assert.equal(passing.status, 0, `unset: exit 0 (stderr ${passing.stderr})`);
  assert.ok(passing.stdout.startsWith('verify-build-hooks: OK'), passing.stdout);

  assertFails(
    runOn({ ...defaultBuild, 'shell-config.js': undefined }, unset),
    ['shell-config.js'],
    'unset, no shell config',
  );

  const padded = runOn(minimalBuild(), { MR_PLAYTEST_DB: `  ${DB}  ` });
  assert.equal(padded.status, 0, `padded: exit 0 (stderr ${padded.stderr})`);
  assert.ok(padded.stdout.startsWith('verify-build-hooks: OK'), padded.stdout);
});

test('the CLI requires index.html to load /shell-config.js with a real classic script tag', () => {
  const page = (head) =>
    `<!doctype html><html><body>${head}` +
    '<script type="module" src="/assets/app.js"></script></body></html>';
  const failing = [
    ['the tag only inside a comment', '<!-- <script src="/shell-config.js"></script> -->'],
    ['async', '<script async src="/shell-config.js"></script>'],
    ['defer', '<script defer src="/shell-config.js"></script>'],
    ['nomodule', '<script nomodule src="/shell-config.js"></script>'],
    ['type="module"', '<script type="module" src="/shell-config.js"></script>'],
    ['only a preload link', '<link rel="preload" href="/shell-config.js" as="script">'],
  ];
  for (const [what, head] of failing) {
    assertFails(runOn({ ...minimalBuild(), 'index.html': page(head) }), ['index.html'], what);
  }
  const passing = [
    ['two spaces after script', '<script  src="/shell-config.js"></script>'],
    ['crossorigin', '<script crossorigin src="/shell-config.js"></script>'],
  ];
  for (const [what, head] of passing) {
    const res = runOn({ ...minimalBuild(), 'index.html': page(head) });
    assert.equal(res.status, 0, `${what}: exit 0 (stderr ${res.stderr})`);
    assert.ok(res.stdout.startsWith('verify-build-hooks: OK'), `${what}: ${res.stdout}`);
  }
});
