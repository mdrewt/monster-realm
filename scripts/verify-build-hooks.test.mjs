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
