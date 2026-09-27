// playtest-verify.eval.mjs — the release-verification CHECKERS (pt-a2), shrunk.
//
// Debloat Phase 2 (EV-playtest-verify#checker-units, KEEP-SHRUNK): only the
// pure-checker cases survive — the real exported functions of
// scripts/verify-release-reducers.mjs (parseReducerNames, findForbiddenReducers)
// and scripts/verify-build-hooks.mjs (findDevHooks, bundleBakesDb), run against
// fixed good/bad inputs. A broken checker would let grant_bait/start_wild_battle
// ship in a published module or a debug window hook ship in a release build.
// Deleted (EV-playtest-verify#recipes-docs-teeth, DELETE): the inline-predicate
// and reference-impl proof-of-teeth, the justfile recipe/runbook/ADR scans and
// the playtest-preflight/up/wipe stub-server runs.
// The row's new_home is scripts/verify-*.test.mjs; nothing runs scripts/*.test.mjs
// today, so the cases stay here, live under evals/run.mjs, until the CI reshape
// wires a runner (handoff recorded in the ledger).
//
// No new RegExp() (Semgrep detect-non-literal-regexp).
// The canonical fingerprint set for findDevHooks (§K §D3 + F4, NO bracket forms, NO __mrBuild).
// Must be exactly the window-binding form plus defineProperty escape.
const DEV_HOOK_FINGERPRINTS = [
  '.__game=',
  '.__game =',
  '.__mrTrade=',
  '.__mrTrade =',
  '.__mrPvp=',
  '.__mrPvp =',
  'defineProperty(window,"__game"',
  "defineProperty(window,'__game'",
  'defineProperty(window,"__mrTrade"',
  "defineProperty(window,'__mrTrade'",
  'defineProperty(window,"__mrPvp"',
  "defineProperty(window,'__mrPvp'",
];

// The canonical forbidden reducer set (§K F1 — exactly 2).
const FORBIDDEN_REDUCERS = ['start_wild_battle', 'grant_bait'];

export default async function () {
  const name =
    'playtest-verify (pt-a2 release checkers: forbidden dev reducers + dev window hooks + baked DB)';

  // ==========================================================================
  // 1. Import the real checkers (a missing export is a FAIL).
  // ==========================================================================

  let parseReducerNames, findForbiddenReducers, findDevHooks, bundleBakesDb;
  try {
    const releaseModule = await import('../scripts/verify-release-reducers.mjs');
    parseReducerNames = releaseModule.parseReducerNames;
    findForbiddenReducers = releaseModule.findForbiddenReducers;
    if (typeof parseReducerNames !== 'function' || typeof findForbiddenReducers !== 'function') {
      return {
        name,
        pass: false,
        detail:
          'scripts/verify-release-reducers.mjs exists but does not export parseReducerNames and/or findForbiddenReducers as functions — §K BLOCKER: pure checkers must be exported',
      };
    }
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `scripts/verify-release-reducers.mjs failed to import (${e?.message ?? String(e)})`,
    };
  }

  try {
    const buildModule = await import('../scripts/verify-build-hooks.mjs');
    findDevHooks = buildModule.findDevHooks;
    bundleBakesDb = buildModule.bundleBakesDb;
    if (typeof findDevHooks !== 'function') {
      return {
        name,
        pass: false,
        detail:
          'scripts/verify-build-hooks.mjs exists but does not export findDevHooks as a function — pure checker must be exported',
      };
    }
    if (typeof bundleBakesDb !== 'function') {
      return {
        name,
        pass: false,
        detail:
          'scripts/verify-build-hooks.mjs exists but does not export bundleBakesDb as a function — pure checker must be exported (pt-a2 build-time DB-bake gate)',
      };
    }
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `scripts/verify-build-hooks.mjs failed to import (${e?.message ?? String(e)})`,
    };
  }

  // ==========================================================================
  // 2. Good/bad fixtures against the real exported implementations.
  // ==========================================================================

  // --- bundleBakesDb real-impl teeth (pt-a2 build-time DB-bake gate, ADR-0128/0129) ---
  // The connectionConfig guard's ERROR MESSAGE hardcodes the example
  // "monster-realm-playtest" via `e.g.`, so it is present in EVERY build. bundleBakesDb
  // must key on the `db:` property VALUE, not a bare DB-name substring, or it fails OPEN
  // — passing a misconfigured (unset VITE_STDB_DB) build whose db is baked `void 0`.
  {
    // GOOD — pretty build form (the honest build is unminified, ADR-0128).
    const bakedPretty = 'const { uri: z0, db: L0 } = yy({\n    db: "monster-realm-playtest"\n  });';
    if (!bundleBakesDb(bakedPretty, 'monster-realm-playtest')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH DB-pretty: bundleBakesDb failed to detect a baked `db: "monster-realm-playtest"` (pretty build form)',
      };
    }
    // GOOD — minified build form.
    if (!bundleBakesDb('a=z({db:"monster-realm-playtest"},!1)', 'monster-realm-playtest')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH DB-min: bundleBakesDb failed to detect a baked `db:"monster-realm-playtest"` (minified build form)',
      };
    }
    // KEY BAD (fail-open killer) — a misconfigured build: only the guard-message example
    // is present and db is baked `void 0`. bundleBakesDb MUST NOT report the DB as baked.
    const guardExampleOnly =
      'set VITE_STDB_DB to the playtest database (e.g. "monster-realm-playtest"), not "";var x=z({db:void 0},!1);';
    if (bundleBakesDb(guardExampleOnly, 'monster-realm-playtest')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH DB-guard-example (fail-open killer): bundleBakesDb reported the DB as baked when ONLY the guard-message example "monster-realm-playtest" is present (db baked void 0) — it must key on the `db:` property value, not a bare DB-name substring',
      };
    }
    // GOOD — a custom (non-default) DB name is honored, not hardcoded to the default.
    if (!bundleBakesDb('q({db: "mr-playtest-2"})', 'mr-playtest-2')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH DB-custom: bundleBakesDb failed to detect a custom baked db name "mr-playtest-2"',
      };
    }
    // BAD — a custom DB absent from the bundle (only the default example present).
    if (bundleBakesDb('database (e.g. "monster-realm-playtest")', 'mr-playtest-2')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH DB-custom-neg: bundleBakesDb false-passed for a custom db "mr-playtest-2" absent from the bundle',
      };
    }
  }

  // --- parseReducerNames real-impl teeth ---

  {
    let threw = false;
    try {
      parseReducerNames('');
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH (real) R1a: parseReducerNames("") must throw — real impl does not fail on empty input; vacuously green on describe failure',
      };
    }
  }

  {
    let threw = false;
    try {
      parseReducerNames('not json{');
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail: 'TEETH (real) R1b: parseReducerNames("not json{") must throw',
      };
    }
  }

  {
    let threw = false;
    try {
      parseReducerNames('{"tables":[]}');
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH (real) R1c: parseReducerNames(\'{"tables":[]}\') must throw — §K B-1/H-2: no reducers key means wrong path or failed introspection',
      };
    }
  }

  {
    let threw = false;
    try {
      parseReducerNames('{"reducers":[]}');
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH (real) R1d: parseReducerNames(\'{"reducers":[]}\') must throw — empty reducer array means introspection failed',
      };
    }
  }

  {
    // Real 2.6.0 flat shape (§K §A-5 confirmed empirically).
    const goodOutput =
      '{"typespace":{},"tables":[],"reducers":[{"name":"join_game","params":{"elements":[]},"lifecycle":{"none":[]}},{"name":"sync_content","params":{"elements":[]},"lifecycle":{"none":[]}}],"types":[],"misc_exports":[],"row_level_security":[]}';
    let names;
    try {
      names = parseReducerNames(goodOutput);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) R1e: parseReducerNames threw on valid 2.6.0 describe output: ${e.message}`,
      };
    }
    if (!Array.isArray(names) || !names.includes('join_game') || !names.includes('sync_content')) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) R1e: parseReducerNames returned ${JSON.stringify(names)} for valid 2.6.0 output — expected array containing join_game + sync_content`,
      };
    }
  }

  {
    // Real 2.8.1 V10 `sections` shape (ADR-0197, captured from a live instance):
    // reducers are externally tagged under `sections[].Reducers` and the name
    // field is `source_name`. Runs against the REAL exported parser.
    const goodV10 =
      '{"sections":[{"Typespace":{"types":[]}},{"Tables":[]},{"Reducers":[{"source_name":"join_game","params":{"elements":[]},"visibility":{"Public":[]}},{"source_name":"sync_content","params":{"elements":[]},"visibility":{"Public":[]}}]}]}';
    let names;
    try {
      names = parseReducerNames(goodV10);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) R1e-v10: parseReducerNames threw on valid 2.8.1 V10 describe output: ${e.message}`,
      };
    }
    if (!Array.isArray(names) || !names.includes('join_game') || !names.includes('sync_content')) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) R1e-v10: parseReducerNames returned ${JSON.stringify(names)} for valid 2.8.1 V10 output — expected array containing join_game + sync_content`,
      };
    }
  }

  // Nested shape (§K F8 path-robustness).
  {
    const nestedOutput =
      '{"schema":{"reducers":[{"name":"join_game"},{"name":"sync_content"},{"name":"accept_challenge"}]}}';
    let names;
    try {
      names = parseReducerNames(nestedOutput);
    } catch {
      // Acceptable if real impl handles only flat shape — path robustness is a SHOULD per §K F8.
      // We don't fail here; the structural tooth on source is the real guard.
      names = null;
    }
    // If it didn't throw and returned results, they should include the names.
    if (names !== null && Array.isArray(names) && names.length > 0) {
      if (!names.includes('join_game')) {
        return {
          name,
          pass: false,
          detail: `TEETH (real) R1f: parseReducerNames parsed nested shape but returned ${JSON.stringify(names)} without join_game`,
        };
      }
    }
  }

  // --- findForbiddenReducers real-impl teeth ---

  {
    const offenders = findForbiddenReducers(
      ['join_game', 'sync_content', 'buy'],
      FORBIDDEN_REDUCERS,
    );
    if (!Array.isArray(offenders) || offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) F1a: findForbiddenReducers returned ${JSON.stringify(offenders)} for production-only reducers — must return []`,
      };
    }
  }

  {
    const offenders = findForbiddenReducers(['join_game', 'start_wild_battle'], FORBIDDEN_REDUCERS);
    if (!Array.isArray(offenders) || !offenders.includes('start_wild_battle')) {
      return {
        name,
        pass: false,
        detail: 'TEETH (real) F1b: findForbiddenReducers did not flag start_wild_battle',
      };
    }
  }

  {
    const offenders = findForbiddenReducers(['grant_bait', 'buy'], FORBIDDEN_REDUCERS);
    if (!Array.isArray(offenders) || !offenders.includes('grant_bait')) {
      return {
        name,
        pass: false,
        detail: 'TEETH (real) F1c: findForbiddenReducers did not flag grant_bait',
      };
    }
  }

  {
    // Exact-match, not substring — §K F1.
    const offenders = findForbiddenReducers(
      ['sync_content', 'grant_item_helper_log'],
      FORBIDDEN_REDUCERS,
    );
    if (!Array.isArray(offenders) || offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) F1d: findForbiddenReducers false-flagged [${offenders.join(',')}] — exact-name match required, not substring`,
      };
    }
  }

  // --- findDevHooks real-impl teeth ---

  {
    const offenders = findDevHooks('var x=1;window.__mrPvp = function(){}', DEV_HOOK_FINGERPRINTS);
    if (!Array.isArray(offenders) || offenders.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH (real) H1a: findDevHooks did not flag "window.__mrPvp = function(){}"',
      };
    }
  }

  {
    const offenders = findDevHooks('(function(){w.__game=1})()', DEV_HOOK_FINGERPRINTS);
    if (!Array.isArray(offenders) || offenders.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH (real) H1b: findDevHooks did not flag "w.__game=1" — .__game= fingerprint must match any receiver',
      };
    }
  }

  {
    const offenders = findDevHooks('window.__mrTrade =x;', DEV_HOOK_FINGERPRINTS);
    if (!Array.isArray(offenders) || offenders.length === 0) {
      return {
        name,
        pass: false,
        detail: 'TEETH (real) H1c: findDevHooks did not flag "window.__mrTrade =x"',
      };
    }
  }

  {
    const offenders = findDevHooks(
      'Object.defineProperty(window,"__mrPvp",{value:fn})',
      DEV_HOOK_FINGERPRINTS,
    );
    if (!Array.isArray(offenders) || offenders.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH (real) H1d: findDevHooks did not flag defineProperty(window,"__mrPvp",...) — §K F4: defineProperty escape must be caught',
      };
    }
  }

  {
    const bundle = 'var a=function(e,t){return e+t};export{a as add};';
    const offenders = findDevHooks(bundle, DEV_HOOK_FINGERPRINTS);
    if (!Array.isArray(offenders) || offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) H2a: findDevHooks false-flagged [${offenders.join(',')}] in a clean bundle`,
      };
    }
  }

  {
    // ADR-0128 §D3 critical anti-FP: dead object literal + bare tokens in comment.
    const deadLiteralBundle = [
      '/* __mrPvp __game debug tokens in sourcemap comment */',
      'var hooks={challengePvp:function(){},proposeTrade:function(){}};',
      'export{hooks};',
    ].join('\n');
    const offenders = findDevHooks(deadLiteralBundle, DEV_HOOK_FINGERPRINTS);
    if (!Array.isArray(offenders) || offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) H2b: findDevHooks false-flagged [${offenders.join(',')}] in dead-literal + comment-token fixture — ADR-0128 §D3: binding form required`,
      };
    }
  }

  {
    // §K F9: ungated prod stamp must NOT be flagged.
    const stampBundle = "window.__mrBuild = {sha:'abc123',time:'2026-07-19'};";
    const offenders = findDevHooks(stampBundle, DEV_HOOK_FINGERPRINTS);
    if (!Array.isArray(offenders) || offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) H2c: findDevHooks false-flagged [${offenders.join(',')}] for "window.__mrBuild = ..." — §K F9: build stamp must not be flagged`,
      };
    }
  }

  return {
    name,
    pass: true,
    detail:
      'release checkers correct: parseReducerNames throws on empty/bad/zero and parses the 2.6.0 flat + 2.8.1 V10 describe shapes; findForbiddenReducers flags start_wild_battle and grant_bait by exact name only; findDevHooks flags binding forms only (no dead-literal / __mrBuild false positive); bundleBakesDb keys on the db: value.',
  };
}
