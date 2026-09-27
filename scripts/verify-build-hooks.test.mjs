// Unit tests for the built-bundle checker (just playtest-verify-build / client-verify-build): a
// broken matcher would let a DEV window hook ship in a release build, or pass a build whose
// playtest DB was never baked in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bundleBakesDb, DEV_HOOK_FINGERPRINTS, findDevHooks } from './verify-build-hooks.mjs';

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

test('bundleBakesDb detects the baked db value in pretty and minified builds', () => {
  assert.ok(
    bundleBakesDb(
      'const { uri: z0, db: L0 } = yy({\n    db: "monster-realm-playtest"\n  });',
      'monster-realm-playtest',
    ),
  );
  assert.ok(bundleBakesDb('a=z({db:"monster-realm-playtest"},!1)', 'monster-realm-playtest'));
  assert.ok(bundleBakesDb('q({db: "mr-playtest-2"})', 'mr-playtest-2'));
});

test('bundleBakesDb keys on the db: value, not the guard message example (fail-open killer)', () => {
  const guardExampleOnly =
    'set VITE_STDB_DB to the playtest database (e.g. "monster-realm-playtest"), not "";var x=z({db:void 0},!1);';
  assert.equal(bundleBakesDb(guardExampleOnly, 'monster-realm-playtest'), false);
  assert.equal(bundleBakesDb('database (e.g. "monster-realm-playtest")', 'mr-playtest-2'), false);
});
