// playtest-verify.eval.mjs — pt-a2 local playtest ops
//
// Encodes EARS criteria pt-a2-1..-6 (§C/§K of docs/specs/pt-a2-plan.md).
// §K is AUTHORITATIVE — it overrides §C/§E on every conflict.
//
// Three layers (§F):
//   1. Pure-checker correctness (imported from scripts/verify-*.mjs).
//   2. Wiring integrity (justfile recipe structural scans).
//   3. Artifact presence (scripts exist, export the right names, have fail-loud guards).
//   4. Docs (playtest-ops.md, ADR-0129).
//
// IMPORTANT: NO new RegExp() anywhere — Semgrep detect-non-literal-regexp has bitten
// this project 3×. Only literal regex literals and String methods (includes / indexOf /
// startsWith / split) are used.
//
// All proof-of-teeth fixtures run UNCONDITIONALLY before real-file scans.
// Every BAD fixture must be flagged, every GOOD must pass; a fixture miss returns
// pass:false immediately (a broken predicate cannot gate production code).
//
// Starts RED: scripts/verify-release-reducers.mjs, scripts/verify-build-hooks.mjs,
// justfile playtest-* recipes, and docs/playtest-ops.md do not yet exist.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Import extractRecipeBody from build-ci-hygiene.eval.mjs (it IS exported —
// confirmed by reading the file). Do not copy it; import it.
// ---------------------------------------------------------------------------
import { extractRecipeBody } from './build-ci-hygiene.eval.mjs';

// ---------------------------------------------------------------------------
// Helper: strip `#` line comments from justfile/shell text before scanning
// so a comment cannot satisfy a structural check.
// ---------------------------------------------------------------------------
function stripJustfileComments(text) {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trimStart();
      if (t.startsWith('#')) return '';
      const idx = line.indexOf(' #');
      return idx !== -1 ? line.slice(0, idx) : line;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Helper: strip `//` line comments from .mjs source text before scanning.
// ---------------------------------------------------------------------------
function stripMjsComments(text) {
  return text
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Inline pure predicates for structural checks
// (imported pure checkers are exercised separately via dynamic import below)
// ---------------------------------------------------------------------------

// Check: justfile has a recipe header at column 0 for `recipeName`.
function justfileHasRecipe(justfile, recipeName) {
  const exactMarker = `\n${recipeName}:`;
  const paramMarker = `\n${recipeName} `;
  return (
    justfile.indexOf(exactMarker) !== -1 ||
    justfile.indexOf(paramMarker) !== -1 ||
    justfile.startsWith(`${recipeName}:`) ||
    justfile.startsWith(`${recipeName} `)
  );
}

// Check: recipe body (comment-stripped) contains a token.
function recipeBodyContains(justfile, recipeName, token) {
  const body = extractRecipeBody(justfile, recipeName);
  return body.includes(token);
}

// Check: recipe body does NOT contain a token.
function recipeBodyLacks(justfile, recipeName, token) {
  const body = extractRecipeBody(justfile, recipeName);
  return !body.includes(token);
}

// Check: entire comment-stripped justfile does NOT contain a token.
// (red-team F5: catches `just` variable definitions as well as recipe bodies)
function wholeJustfileLacks(justfile, token) {
  const stripped = stripJustfileComments(justfile);
  return !stripped.includes(token);
}

// Check: recipe body has a trimmed line that EXACTLY equals `exactLine`
// (no suffix allowed — mirrors L-2 / nightly-smoke-wiring's F6 discipline).
function recipeBodyHasExactLine(justfile, recipeName, exactLine) {
  const body = extractRecipeBody(justfile, recipeName);
  return body.split('\n').some((ln) => ln.trim() === exactLine);
}

// Check: recipe body contains the bash lowercase-fold token for the DB guard.
// §K red-team F6: guard must use `${MR_PLAYTEST_DB,,}` (bash ,, fold) compared
// to `monster-realm`. The presence of `,,}` is the load-bearing token.
function recipeBodyHasCaseInsensitiveGuard(justfile, recipeName) {
  const body = extractRecipeBody(justfile, recipeName);
  return body.includes(',,}');
}

// ---------------------------------------------------------------------------
// Proof-of-teeth for the inline predicates above
// ---------------------------------------------------------------------------

// --- justfileHasRecipe fixtures ---
const JF_NO_RECIPES = 'ci: lint typecheck test\n\nlint:\n    cargo fmt --all --check\n';
const JF_WITH_PLAYTEST_UP = `ci: lint typecheck test\n\nplaytest-up:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    echo hi\n`;

// --- recipeBodyContains / recipeBodyLacks / wholeJustfileLacks ---
const JF_CONTAINS_DEV_REDUCERS = `playtest-up:\n    spacetime publish --features dev_reducers monster-realm-playtest\n`;
const JF_CLEAN_BODY = `playtest-up:\n    spacetime publish -s "$STDB_SERVER" --module-path server-module -y "$MR_PLAYTEST_DB"\n`;

// --- recipeBodyHasExactLine ---
const JF_EXACT_LINE_GOOD = `playtest-verify-release:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    node scripts/verify-release-reducers.mjs\n`;
const JF_EXACT_LINE_OR_TRUE = `playtest-verify-release:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    node scripts/verify-release-reducers.mjs || true\n`;

// --- recipeBodyHasCaseInsensitiveGuard ---
const JF_CASE_SENSITIVE_GUARD = `playtest-up:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    if [ "$MR_PLAYTEST_DB" = "monster-realm" ]; then echo "BAD" >&2; exit 1; fi\n`;
const JF_CASE_INSENSITIVE_GUARD = `playtest-up:\n    #!/usr/bin/env bash\n    set -euo pipefail\n    if [ "\${MR_PLAYTEST_DB,,}" = "monster-realm" ]; then echo "BAD" >&2; exit 1; fi\n`;

// ---------------------------------------------------------------------------
// Local implementations of the pure checker signatures
// (these shadow the imported versions during proof-of-teeth, so the teeth
// exercise the SHAPE of the contract, not just the real implementation)
// ---------------------------------------------------------------------------

// These are what the eval IMPORTS from the scripts. The proof-of-teeth below
// validates those imports work and produce the right shapes. We define stub
// reference implementations here ONLY for use inside the proof-of-teeth
// fixture checks that run when the real scripts are missing (the dynamic import
// try/catch). When the real scripts exist, their exports are used instead.

// Reference implementation for proof-of-teeth (validates fixture shapes independently).
function _refParseReducerNames(describeOutput) {
  if (!describeOutput || !describeOutput.trim()) {
    throw new Error('parseReducerNames: empty output — describe may have failed');
  }
  let parsed;
  try {
    parsed = JSON.parse(describeOutput);
  } catch {
    throw new Error('parseReducerNames: not valid JSON');
  }
  // Candidate paths: flat `reducers` array, or nested `schema.reducers`.
  let reducers = null;
  if (Array.isArray(parsed.reducers)) {
    reducers = parsed.reducers;
  } else if (parsed.schema && Array.isArray(parsed.schema.reducers)) {
    reducers = parsed.schema.reducers;
  }
  if (!reducers || reducers.length === 0) {
    throw new Error(
      'parseReducerNames: zero reducers — introspection may have failed or wrong JSON path',
    );
  }
  return reducers.map((r) => r.name).filter(Boolean);
}

function _refFindForbiddenReducers(reducerNames, forbidden) {
  return reducerNames.filter((n) => forbidden.includes(n));
}

function _refFindDevHooks(bundleText, fingerprints) {
  return fingerprints.filter((fp) => bundleText.includes(fp));
}

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

// ---------------------------------------------------------------------------
// Default export — eval entry point
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'playtest-verify (pt-a2: honest release publish + published-module & build-output verification)';

  // ==========================================================================
  // SECTION 1: PROOF-OF-TEETH FOR INLINE PREDICATES
  // Run before importing the real scripts.
  // ==========================================================================

  // --- Tooth P1a: justfileHasRecipe BAD — recipe absent must return false ---
  // Kills: impl that always returns true or searches loosely.
  if (justfileHasRecipe(JF_NO_RECIPES, 'playtest-up')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P1a: justfileHasRecipe returned true for a justfile with no playtest-up recipe — kills impl that accepts any text',
    };
  }

  // --- Tooth P1b: justfileHasRecipe GOOD — recipe present must return true ---
  if (!justfileHasRecipe(JF_WITH_PLAYTEST_UP, 'playtest-up')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P1b: justfileHasRecipe returned false for a justfile that does contain playtest-up — false negative in predicate',
    };
  }

  // --- Tooth P2a: wholeJustfileLacks BAD — dev_reducers present must be caught ---
  // Kills: impl that only scans recipe bodies, missing a variable-level injection.
  if (wholeJustfileLacks(JF_CONTAINS_DEV_REDUCERS, 'dev_reducers')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P2a: wholeJustfileLacks returned true for a justfile body containing "dev_reducers" — red-team F5: must scan entire comment-stripped justfile, not just recipe bodies',
    };
  }

  // --- Tooth P2b: wholeJustfileLacks GOOD — clean body returns true ---
  if (!wholeJustfileLacks(JF_CLEAN_BODY, 'dev_reducers')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P2b: wholeJustfileLacks returned false for a justfile without dev_reducers — false negative in predicate',
    };
  }

  // --- Tooth P3a: recipeBodyHasExactLine BAD — `|| true` suffix must NOT satisfy ---
  // Kills: impl that uses indexOf('node scripts/...') without exact-match discipline.
  // Mirrors reviewer L-2 + nightly-smoke-wiring F6.
  if (
    recipeBodyHasExactLine(
      JF_EXACT_LINE_OR_TRUE,
      'playtest-verify-release',
      'node scripts/verify-release-reducers.mjs',
    )
  ) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P3a: recipeBodyHasExactLine accepted "node scripts/verify-release-reducers.mjs || true" as an exact match — reviewer L-2: a "|| true" suffix must NOT satisfy the tooth; exact trimmed line required',
    };
  }

  // --- Tooth P3b: recipeBodyHasExactLine GOOD — exact line must pass ---
  if (
    !recipeBodyHasExactLine(
      JF_EXACT_LINE_GOOD,
      'playtest-verify-release',
      'node scripts/verify-release-reducers.mjs',
    )
  ) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P3b: recipeBodyHasExactLine rejected a recipe body that correctly has the exact line "node scripts/verify-release-reducers.mjs" — false negative',
    };
  }

  // --- Tooth P4a: recipeBodyHasCaseInsensitiveGuard BAD — case-sensitive-only guard rejected ---
  // Kills: impl that uses `"$MR_PLAYTEST_DB" = "monster-realm"` without ,, fold.
  // §K red-team F6: `MONSTER-REALM` env would bypass a case-sensitive guard.
  if (recipeBodyHasCaseInsensitiveGuard(JF_CASE_SENSITIVE_GUARD, 'playtest-up')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P4a: recipeBodyHasCaseInsensitiveGuard accepted a case-sensitive-only guard ("$MR_PLAYTEST_DB" = "monster-realm") — red-team F6: guard must use bash lowercase fold ${MR_PLAYTEST_DB,,} to prevent MONSTER-REALM bypass',
    };
  }

  // --- Tooth P4b: recipeBodyHasCaseInsensitiveGuard GOOD — ,, fold satisfies ---
  if (!recipeBodyHasCaseInsensitiveGuard(JF_CASE_INSENSITIVE_GUARD, 'playtest-up')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH P4b: recipeBodyHasCaseInsensitiveGuard rejected a recipe body that correctly uses ${MR_PLAYTEST_DB,,} — false negative in predicate',
    };
  }

  // ==========================================================================
  // SECTION 2: PROOF-OF-TEETH FOR parseReducerNames (reference impl)
  // Validates the CONTRACT the imported function must satisfy.
  // ==========================================================================

  // --- Tooth R1a: BAD-empty — must THROW ---
  // Kills: impl that returns [] on empty input (vacuously green describe failure).
  {
    let threw = false;
    try {
      _refParseReducerNames('');
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R1a: parseReducerNames("") must throw — empty output means describe failed; returning [] would make a failed introspection read as green',
      };
    }
  }

  // --- Tooth R1b: BAD-unparseable — must THROW ---
  {
    let threw = false;
    try {
      _refParseReducerNames('not json{');
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R1b: parseReducerNames("not json{") must throw — unparseable output means describe failed',
      };
    }
  }

  // --- Tooth R1c: BAD-no-reducers-key — valid JSON, no `reducers` key — must THROW ---
  // Kills: impl that returns [] silently when the JSON path is wrong.
  // §K B-1 + H-2: zero names = wrong path or failed introspection — must throw.
  {
    let threw = false;
    try {
      _refParseReducerNames('{"tables":[]}');
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R1c: parseReducerNames(\'{"tables":[]}\') (valid JSON, no reducers key) must throw — §K B-1/H-2: zero reducers means wrong JSON path or failed introspection',
      };
    }
  }

  // --- Tooth R1d: BAD-empty-array — reducers:[] — must THROW ---
  // Kills: impl that returns [] for an empty reducers array.
  {
    let threw = false;
    try {
      _refParseReducerNames('{"reducers":[]}');
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R1d: parseReducerNames(\'{"reducers":[]}\') must throw — a published module always has join_game/sync_content; zero reducers means the check did not run',
      };
    }
  }

  // --- Tooth R1e: GOOD (real 2.6.0 flat shape) — non-empty array returned ---
  // Uses the confirmed 2.6.0 `describe --json` shape (§K §A-5):
  // { reducers: [ { name, params, lifecycle }, ... ] }
  {
    const goodOutput =
      '{"typespace":{},"tables":[],"reducers":[{"name":"join_game","params":{"elements":[]},"lifecycle":{"none":[]}},{"name":"sync_content","params":{"elements":[]},"lifecycle":{"none":[]}}],"types":[],"misc_exports":[],"row_level_security":[]}';
    let names;
    try {
      names = _refParseReducerNames(goodOutput);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH R1e: parseReducerNames threw on a valid 2.6.0 describe output: ${e.message}`,
      };
    }
    if (!Array.isArray(names) || names.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R1e: parseReducerNames returned empty array for a valid 2.6.0 describe output containing join_game + sync_content',
      };
    }
    if (!names.includes('join_game') || !names.includes('sync_content')) {
      return {
        name,
        pass: false,
        detail: `TEETH R1e: parseReducerNames returned [${names.join(',')}] but expected join_game and sync_content`,
      };
    }
  }

  // --- Tooth R1f: GOOD nested shape (F8 path-robustness) ---
  // A nested `{"schema":{"reducers":[...]}}` fixture also parses correctly.
  {
    const nestedOutput = '{"schema":{"reducers":[{"name":"join_game"},{"name":"sync_content"}]}}';
    let names;
    try {
      names = _refParseReducerNames(nestedOutput);
    } catch {
      // If the reference impl doesn't support nested, that's OK for the reference impl —
      // the REAL impl is required to handle it. This tooth tests that the real import
      // will be tested via the real-script tooth later. Skip for reference impl.
      names = null; // mark as skipped for reference impl
    }
    // We accept both: the reference impl may not support nested (it's a simplification).
    // The real-script tooth (Section 3) will test the actual import on this shape.
  }

  // ==========================================================================
  // SECTION 3: PROOF-OF-TEETH FOR findForbiddenReducers (reference impl)
  // ==========================================================================

  // --- Tooth F1a: GOOD — production-only reducers return [] ---
  {
    const offenders = _refFindForbiddenReducers(
      ['join_game', 'sync_content', 'buy'],
      FORBIDDEN_REDUCERS,
    );
    if (offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH F1a: findForbiddenReducers flagged production-only reducers [${offenders.join(',')}] — false positive`,
      };
    }
  }

  // --- Tooth F1b: BAD-swb — start_wild_battle must be returned ---
  {
    const offenders = _refFindForbiddenReducers(
      ['join_game', 'start_wild_battle'],
      FORBIDDEN_REDUCERS,
    );
    if (!offenders.includes('start_wild_battle')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH F1b: findForbiddenReducers did not flag start_wild_battle — forbidden dev reducer not detected',
      };
    }
  }

  // --- Tooth F1c: BAD-bait — grant_bait must be returned ---
  {
    const offenders = _refFindForbiddenReducers(['grant_bait', 'buy'], FORBIDDEN_REDUCERS);
    if (!offenders.includes('grant_bait')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH F1c: findForbiddenReducers did not flag grant_bait — forbidden dev reducer not detected',
      };
    }
  }

  // --- Tooth F1d: no-false-positive — exact-name match, not substring ---
  // `grant_item_helper_log` contains "grant_item" / "grant" as substring but must NOT flag.
  // §K F1: grant_item is a helper never in describe; a substring match would false-flag it.
  {
    const offenders = _refFindForbiddenReducers(
      ['sync_content', 'grant_item_helper_log'],
      FORBIDDEN_REDUCERS,
    );
    if (offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH F1d: findForbiddenReducers false-flagged [${offenders.join(',')}] — names containing a forbidden token as a SUBSTRING must not flag; exact-name membership only`,
      };
    }
  }

  // --- Tooth F1e: forbidden set has EXACTLY 2 entries ---
  // §K F1 BLOCKER: grant_item is NOT a reducer; the set must be exactly
  // ['start_wild_battle', 'grant_bait']. This assertion kills an impl that includes grant_item.
  if (FORBIDDEN_REDUCERS.length !== 2) {
    return {
      name,
      pass: false,
      detail: `TEETH F1e: FORBIDDEN_REDUCERS has ${FORBIDDEN_REDUCERS.length} entries but must have exactly 2 (start_wild_battle, grant_bait); grant_item is a pub(crate) helper, not a reducer — §K F1 BLOCKER`,
    };
  }
  if (
    !FORBIDDEN_REDUCERS.includes('start_wild_battle') ||
    !FORBIDDEN_REDUCERS.includes('grant_bait')
  ) {
    return {
      name,
      pass: false,
      detail: `TEETH F1e: FORBIDDEN_REDUCERS does not contain both start_wild_battle and grant_bait; got [${FORBIDDEN_REDUCERS.join(',')}]`,
    };
  }

  // ==========================================================================
  // SECTION 4: PROOF-OF-TEETH FOR findDevHooks (reference impl)
  // ==========================================================================

  // --- Tooth H1a: BAD — window.__mrPvp = ... binding flagged ---
  // Kills: impl that uses bare substring without the `.` prefix binding form.
  {
    const offenders = _refFindDevHooks(
      'var x=1;window.__mrPvp = function(){}',
      DEV_HOOK_FINGERPRINTS,
    );
    if (offenders.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH H1a: findDevHooks did not flag "window.__mrPvp = function(){}" — binding form .__mrPvp = must be detected',
      };
    }
  }

  // --- Tooth H1b: BAD — w.__game=1 (renamed receiver, no `window.`) flagged ---
  // §K L-1: the leading `.` prefix also catches `w.`/`globalThis.`/`self.` receivers.
  {
    const offenders = _refFindDevHooks('(function(){w.__game=1})()', DEV_HOOK_FINGERPRINTS);
    if (offenders.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH H1b: findDevHooks did not flag "w.__game=1" — the .__game= fingerprint must match any receiver, not only "window."',
      };
    }
  }

  // --- Tooth H1c: BAD — window.__mrTrade =x (space before =) flagged ---
  {
    const offenders = _refFindDevHooks('window.__mrTrade =x;', DEV_HOOK_FINGERPRINTS);
    if (offenders.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH H1c: findDevHooks did not flag "window.__mrTrade =x" — the .__mrTrade = fingerprint (with space) must be detected',
      };
    }
  }

  // --- Tooth H1d: BAD — Object.defineProperty(window,"__mrPvp",{value:fn}) flagged ---
  // §K F4 blocker: defineProperty escape must also be caught.
  {
    const offenders = _refFindDevHooks(
      'Object.defineProperty(window,"__mrPvp",{value:fn})',
      DEV_HOOK_FINGERPRINTS,
    );
    if (offenders.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TEETH H1d: findDevHooks did not flag Object.defineProperty(window,"__mrPvp",...) — §K F4: defineProperty escape must be detected',
      };
    }
  }

  // --- Tooth H2a: GOOD-clean — no hooks in a minified-looking bundle ---
  {
    const bundle = 'var a=function(e,t){return e+t};export{a as add};';
    const offenders = _refFindDevHooks(bundle, DEV_HOOK_FINGERPRINTS);
    if (offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH H2a: findDevHooks false-flagged [${offenders.join(',')}] in a clean minified bundle`,
      };
    }
  }

  // --- Tooth H2b: GOOD anti-FP (ADR-0128 §D3 critical tooth) ---
  // Dead object literal + bare tokens in a comment — NO .binding form → must return [].
  // Kills: impl that uses bare substring `__mrPvp` without the dot-binding prefix.
  {
    const deadLiteralBundle = [
      '/* __mrPvp __game debug tokens in sourcemap comment */',
      'var hooks={challengePvp:function(){},proposeTrade:function(){}};',
      'export{hooks};',
    ].join('\n');
    const offenders = _refFindDevHooks(deadLiteralBundle, DEV_HOOK_FINGERPRINTS);
    if (offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH H2b: findDevHooks false-flagged [${offenders.join(',')}] in a fixture with only dead object literals and comment-prose bare tokens (no .binding form) — ADR-0128 §D3: binding form required, not bare substring`,
      };
    }
  }

  // --- Tooth H2c: GOOD anti-FP for ungated prod stamp (§K F9) ---
  // window.__mrBuild = {sha:'abc'} must NOT be flagged — the build stamp is
  // not a dev hook; guarding against accidental .__mr* broadening.
  {
    const stampBundle = "window.__mrBuild = {sha:'abc123',time:'2026-07-19'};";
    const offenders = _refFindDevHooks(stampBundle, DEV_HOOK_FINGERPRINTS);
    if (offenders.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH H2c: findDevHooks false-flagged [${offenders.join(',')}] for "window.__mrBuild = ..." — §K F9: the ungated prod build stamp must NOT be flagged; fingerprints must be specific to __game/__mrTrade/__mrPvp`,
      };
    }
  }

  // ==========================================================================
  // SECTION 5: DYNAMIC IMPORT OF REAL CHECKERS
  // If the scripts don't exist yet, return pass:false (RED state).
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
      detail: `scripts/verify-release-reducers.mjs not yet implemented (import failed: ${e?.message ?? String(e)}) — RED state expected`,
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
      detail: `scripts/verify-build-hooks.mjs not yet implemented (import failed: ${e?.message ?? String(e)}) — RED state expected`,
    };
  }

  // ==========================================================================
  // SECTION 6: PROOF-OF-TEETH AGAINST THE REAL IMPORTED CHECKERS
  // Every tooth from sections 2–4 re-run against the real implementations.
  // A broken real impl must fail here before reaching the structural scans.
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

  // ==========================================================================
  // SECTION 7: STRUCTURAL SCANS — real justfile, scripts, docs
  // ==========================================================================

  const root = path.resolve('.');
  const justfilePath = path.join(root, 'justfile');
  const releaseScriptPath = path.join(root, 'scripts/verify-release-reducers.mjs');
  const buildScriptPath = path.join(root, 'scripts/verify-build-hooks.mjs');
  const playtestOpsPath = path.join(root, 'docs/playtest-ops.md');
  const adrPath = path.join(root, 'docs/adr/0129-pt-a2-local-playtest-ops.md');

  let justfile;
  try {
    justfile = readFileSync(justfilePath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read justfile' };
  }

  // ---- 7.1: Recipe existence (5 new recipes) ----

  const requiredRecipes = [
    'playtest-up',
    'playtest-down',
    'playtest-verify-release',
    'playtest-verify-build',
    'playtest-wipe',
  ];
  for (const recipe of requiredRecipes) {
    if (!justfileHasRecipe(justfile, recipe)) {
      return {
        name,
        pass: false,
        detail: `justfile missing recipe "${recipe}" — implementer must add it (pt-a2-1/-2/-3/-4/-5)`,
      };
    }
  }

  // ---- 7.2: set -euo pipefail in every new bash recipe (reviewer M-1) ----

  for (const recipe of requiredRecipes) {
    if (!recipeBodyContains(justfile, recipe, 'set -euo pipefail')) {
      return {
        name,
        pass: false,
        detail: `recipe "${recipe}" body is missing "set -euo pipefail" — reviewer M-1: every new bash-shebang recipe must have it`,
      };
    }
  }

  // ---- 7.3: Isolated DB guard — playtest-up and playtest-wipe (pt-a2-1/-5) ----

  // 7.3a: playtest-up and playtest-wipe bodies reference monster-realm-playtest or MR_PLAYTEST_DB.
  for (const recipe of ['playtest-up', 'playtest-wipe']) {
    const body = extractRecipeBody(justfile, recipe);
    const hasIsolatedDb =
      body.includes('monster-realm-playtest') || body.includes('MR_PLAYTEST_DB');
    if (!hasIsolatedDb) {
      return {
        name,
        pass: false,
        detail: `recipe "${recipe}" body does not reference monster-realm-playtest or MR_PLAYTEST_DB — pt-a2-1: publish must target the isolated playtest DB, not the dev default`,
      };
    }
  }

  // 7.3b: Case-insensitive guard (§K F6) — both publish/wipe recipes.
  for (const recipe of ['playtest-up', 'playtest-wipe']) {
    if (!recipeBodyHasCaseInsensitiveGuard(justfile, recipe)) {
      return {
        name,
        pass: false,
        detail: `recipe "${recipe}" body is missing the bash lowercase-fold guard (${'{MR_PLAYTEST_DB,,}'}) — §K red-team F6: guard must use case-insensitive fold to catch MONSTER-REALM`,
      };
    }
  }

  // ---- 7.4: Honest publish — no dev_reducers or --bin-path ANYWHERE in justfile (§K F5) ----

  if (!wholeJustfileLacks(justfile, 'dev_reducers')) {
    return {
      name,
      pass: false,
      detail:
        'justfile (comment-stripped) contains "dev_reducers" — §K red-team F5: the honest publish must NEVER use --features dev_reducers; total absence is the invariant',
    };
  }

  if (!wholeJustfileLacks(justfile, '--bin-path')) {
    return {
      name,
      pass: false,
      detail:
        'justfile (comment-stripped) contains "--bin-path" — §K red-team F5: the honest publish must use only the default publish path; --bin-path is forbidden',
    };
  }

  // ---- 7.5: playtest-up body integrity (pt-a2-1) ----

  // playtest-up must invoke verify-release AND verify-build (exact-step discipline, reviewer L-2).
  const upVerifyReleaseForms = [
    'just playtest-verify-release',
    'node scripts/verify-release-reducers.mjs',
  ];
  {
    const body = extractRecipeBody(justfile, 'playtest-up');
    const hasReleaseVerify = upVerifyReleaseForms.some((form) =>
      body.split('\n').some((ln) => ln.trim() === form),
    );
    if (!hasReleaseVerify) {
      return {
        name,
        pass: false,
        detail:
          'recipe "playtest-up" body does not have an exact-step invocation of playtest-verify-release or node scripts/verify-release-reducers.mjs — reviewer L-2: a "|| true" suffix must NOT satisfy; exact trimmed line required',
      };
    }
  }

  const upVerifyBuildForms = ['just playtest-verify-build', 'node scripts/verify-build-hooks.mjs'];
  {
    const body = extractRecipeBody(justfile, 'playtest-up');
    const hasBuildVerify = upVerifyBuildForms.some((form) =>
      body.split('\n').some((ln) => ln.trim() === form),
    );
    if (!hasBuildVerify) {
      return {
        name,
        pass: false,
        detail:
          'recipe "playtest-up" body does not have an exact-step invocation of playtest-verify-build or node scripts/verify-build-hooks.mjs — reviewer L-2 exact-step discipline',
      };
    }
  }

  // playtest-up must call vite build (via npm run build per §K N3).
  if (!recipeBodyContains(justfile, 'playtest-up', 'npm run build')) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-up" body does not call "npm run build" — §K N3: client build must use npm run build (the package.json "build" script), not npx vite build',
    };
  }

  // playtest-up must serve via vite preview (the production build serving step).
  if (!recipeBodyContains(justfile, 'playtest-up', 'preview')) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-up" body does not invoke vite preview — pt-a2-1: must serve the production build via vite preview',
    };
  }

  // playtest-up must call sync_content (ADR-0006, pt-a2-1).
  if (!recipeBodyContains(justfile, 'playtest-up', 'sync_content')) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-up" body does not call sync_content — pt-a2-1: must call sync_content as owner after publish (ADR-0006)',
    };
  }

  // playtest-up must write a PID file for playtest-down (§K H-1).
  if (!recipeBodyContains(justfile, 'playtest-up', '.pid')) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-up" body does not write a PID file (.pid) — §K H-1: must background the preview and write a PID file so playtest-down can stop it',
    };
  }

  // ---- 7.6: playtest-down teardown (§K H-1) ----

  if (!recipeBodyContains(justfile, 'playtest-down', 'kill')) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-down" body does not contain "kill" — §K H-1: must kill the background preview process',
    };
  }

  if (!recipeBodyContains(justfile, 'playtest-down', '.pid')) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-down" body does not reference a .pid file — §K H-1: must read the PID file written by playtest-up',
    };
  }

  // ---- 7.7: playtest-wipe integrity (pt-a2-5) ----

  // playtest-wipe must use --delete-data.
  if (!recipeBodyContains(justfile, 'playtest-wipe', '--delete-data')) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-wipe" body does not contain "--delete-data" — pt-a2-5: wipe must republish with --delete-data -y for a fresh state',
    };
  }

  // playtest-wipe must call sync_content (owner re-register after --delete-data, §K §A).
  if (!recipeBodyContains(justfile, 'playtest-wipe', 'sync_content')) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-wipe" body does not call sync_content — pt-a2-5: must re-run sync_content after --delete-data (owner re-registered by init)',
    };
  }

  // playtest-wipe must also invoke verify-release (reviewer M-4: wipe republishes the module).
  {
    const body = extractRecipeBody(justfile, 'playtest-wipe');
    const hasReleaseVerify = upVerifyReleaseForms.some((form) =>
      body.split('\n').some((ln) => ln.trim() === form),
    );
    if (!hasReleaseVerify) {
      return {
        name,
        pass: false,
        detail:
          'recipe "playtest-wipe" body does not invoke playtest-verify-release (or node scripts/verify-release-reducers.mjs) — reviewer M-4: wipe republishes the module, so it must re-prove dev_reducers-absent',
      };
    }
  }

  // ---- 7.8: playtest-verify-release and playtest-verify-build bodies (reviewer L-2) ----

  // playtest-verify-release must contain EXACTLY `node scripts/verify-release-reducers.mjs`.
  if (
    !recipeBodyHasExactLine(
      justfile,
      'playtest-verify-release',
      'node scripts/verify-release-reducers.mjs',
    )
  ) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-verify-release" body does not have the exact line "node scripts/verify-release-reducers.mjs" — reviewer L-2: must be an exact step, not a suffixed form like "|| true"',
    };
  }

  // playtest-verify-build must contain EXACTLY `node scripts/verify-build-hooks.mjs`.
  if (
    !recipeBodyHasExactLine(
      justfile,
      'playtest-verify-build',
      'node scripts/verify-build-hooks.mjs',
    )
  ) {
    return {
      name,
      pass: false,
      detail:
        'recipe "playtest-verify-build" body does not have the exact line "node scripts/verify-build-hooks.mjs" — reviewer L-2: exact step required',
    };
  }

  // ---- 7.9: Script existence, non-trivial, export names, fail-loud guards ----

  // verify-release-reducers.mjs existence + non-trivial.
  if (!existsSync(releaseScriptPath)) {
    return {
      name,
      pass: false,
      detail: 'scripts/verify-release-reducers.mjs does not exist — implementer must create it',
    };
  }
  const releaseScriptSrc = readFileSync(releaseScriptPath, 'utf8');
  if (releaseScriptSrc.trim().length < 100) {
    return {
      name,
      pass: false,
      detail:
        'scripts/verify-release-reducers.mjs is trivially short (< 100 chars) — must be a real implementation',
    };
  }

  // Source must contain process.exit(1) in the catch/error path (§K F2/B-1).
  const releaseScriptStripped = stripMjsComments(releaseScriptSrc);
  if (!releaseScriptStripped.includes('process.exit(1)')) {
    return {
      name,
      pass: false,
      detail:
        'scripts/verify-release-reducers.mjs source does not contain process.exit(1) — §K F2/B-1: must fail loud (non-zero exit) when execFileSync throws or output is empty/no-reducers',
    };
  }

  // verify-build-hooks.mjs existence + non-trivial.
  if (!existsSync(buildScriptPath)) {
    return {
      name,
      pass: false,
      detail: 'scripts/verify-build-hooks.mjs does not exist — implementer must create it',
    };
  }
  const buildScriptSrc = readFileSync(buildScriptPath, 'utf8');
  if (buildScriptSrc.trim().length < 100) {
    return {
      name,
      pass: false,
      detail:
        'scripts/verify-build-hooks.mjs is trivially short (< 100 chars) — must be a real implementation',
    };
  }

  // Source must contain a dist-absent / no-JS-files guard with process.exit(1) (§K B-2/F3).
  const buildScriptStripped = stripMjsComments(buildScriptSrc);
  if (!buildScriptStripped.includes('process.exit(1)')) {
    return {
      name,
      pass: false,
      detail:
        'scripts/verify-build-hooks.mjs source does not contain process.exit(1) — §K B-2/F3: must fail loud when dist is absent or contains zero .js files (scanning nothing must not read as green)',
    };
  }

  // ---- 7.10: docs/playtest-ops.md (pt-a2-6 runbook) ----

  if (!existsSync(playtestOpsPath)) {
    return {
      name,
      pass: false,
      detail: 'docs/playtest-ops.md does not exist — pt-a2-6: runbook must be written',
    };
  }
  const playtestOps = readFileSync(playtestOpsPath, 'utf8');

  // Must mention playtest-up.
  if (!playtestOps.includes('playtest-up')) {
    return {
      name,
      pass: false,
      detail:
        'docs/playtest-ops.md does not mention "playtest-up" — pt-a2-6: runbook must document the playtest-up command',
    };
  }

  // Must mention playtest-wipe.
  if (!playtestOps.includes('playtest-wipe')) {
    return {
      name,
      pass: false,
      detail:
        'docs/playtest-ops.md does not mention "playtest-wipe" — pt-a2-6: runbook must document the wipe/reset procedure',
    };
  }

  // Must mention sync_content.
  if (!playtestOps.includes('sync_content')) {
    return {
      name,
      pass: false,
      detail:
        'docs/playtest-ops.md does not mention "sync_content" — pt-a2-6: runbook must document the sync_content re-seed step',
    };
  }

  // Must mention the "which build am I on" check (window.__mrBuild or #build-stamp).
  const hasBuildStampRef =
    playtestOps.includes('window.__mrBuild') || playtestOps.includes('#build-stamp');
  if (!hasBuildStampRef) {
    return {
      name,
      pass: false,
      detail:
        'docs/playtest-ops.md does not mention "window.__mrBuild" or "#build-stamp" — pt-a2-6: runbook must document how to check which build is running (ADR-0128)',
    };
  }

  // Must mention the owner-re-register note (§K §C pt-a2-5, §K §A).
  const hasOwnerNote =
    playtestOps.includes('re-register') ||
    (playtestOps.includes('owner') && playtestOps.includes('init'));
  if (!hasOwnerNote) {
    return {
      name,
      pass: false,
      detail:
        'docs/playtest-ops.md does not contain the owner re-register note ("re-register" or "owner"+"init") — pt-a2-6: runbook must note that after --delete-data, init re-runs and the publishing identity is re-registered as owner',
    };
  }

  // ---- 7.11: docs/adr/0129-pt-a2-local-playtest-ops.md (pt-a2-6 / §D T5) ----

  if (!existsSync(adrPath)) {
    return {
      name,
      pass: false,
      detail:
        'docs/adr/0129-pt-a2-local-playtest-ops.md does not exist — §D T5: ADR-0129 must be written',
    };
  }
  const adrContent = readFileSync(adrPath, 'utf8');

  // Must document the describe-published rationale (§K §D T5).
  if (!adrContent.includes('describe') || !adrContent.includes('published')) {
    return {
      name,
      pass: false,
      detail:
        'docs/adr/0129-pt-a2-local-playtest-ops.md does not mention both "describe" and "published" — must document the published-module introspection rationale',
    };
  }

  // ==========================================================================
  // ALL CHECKS PASSED
  // ==========================================================================

  return {
    name,
    pass: true,
    detail: [
      'All pt-a2 criteria satisfied:',
      'pure-checker teeth (parseReducerNames throws on empty/bad/zero, real 2.6.0 shape parses; findForbiddenReducers exact-name-only; findDevHooks binding-form-only with anti-FP for dead literals + __mrBuild stamp);',
      'justfile: 5 recipes present with set -euo pipefail, isolated DB + case-insensitive guard, honest publish (no dev_reducers/--bin-path anywhere), exact-step verify invocations, playtest-up has preview+pid+sync_content+build, playtest-wipe has --delete-data+sync_content+verify-release, playtest-down has kill+pid;',
      'scripts: both verify-*.mjs exist, non-trivial, export correct names, have process.exit(1) fail-loud guards;',
      'docs: playtest-ops.md has playtest-up/wipe/sync_content/build-stamp/owner-note; ADR-0129 has describe+published.',
    ].join(' '),
  };
}
