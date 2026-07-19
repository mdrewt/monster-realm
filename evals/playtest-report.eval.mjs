// playtest-report.eval.mjs — pt-b2 server observability (ADR-0131)
//
// Encodes EARS criteria for scripts/playtest-report.mjs and the
// `just playtest-report` justfile recipe:
//
//   1. `aggregateReport([])` returns zeroed rates with NO NaN/Infinity, no throw.
//   2. A fixture of recruit rows (mix of hp, success, bait, recatch) → correct
//      weakenFirstRate, successRate, baitRate, recatchRate (hand-computed).
//   3. The return object contains NO identity/hex string field (PII-firewall).
//   4. justfile has a `playtest-report` recipe.
//   5. scripts/playtest-report.mjs exports `aggregateReport`.
//   6. script uses `execFileSync` (array-args safety) — no shell-string interpolation
//      of `spacetime sql`.
//   7. script has a `process.exit(1)` fail-loud path.
//   8. script filters `kind === 1` (only RecruitAttempt events).
//
// IMPORTANT: NO new RegExp() anywhere — Semgrep detect-non-literal-regexp.
// Only literal regex and String methods (indexOf / includes / startsWith / split).
//
// All proof-of-teeth for pure predicates run UNCONDITIONALLY before real scans.
//
// RED STATE TODAY: scripts/playtest-report.mjs does not exist → dynamic import
// fails → pass:false.  justfile has no `playtest-report` recipe → scan fails.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Import extractRecipeBody from build-ci-hygiene.eval.mjs (confirmed exported).
// ---------------------------------------------------------------------------
import { extractRecipeBody } from './build-ci-hygiene.eval.mjs';

// ---------------------------------------------------------------------------
// Helper: strip `#` line-comment lines from justfile/shell text.
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
// Helper: strip `//` line comments from .mjs source text.
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
// Helper: check whether justfile has a recipe named `recipeName`.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Pure reference implementations — used for proof-of-teeth fixtures only.
// These mirror the CONTRACT that the real aggregateReport must satisfy.
//
// Reference: the spec defines for a set of PlaytestEvent rows:
//   - weakenFirstRate: fraction of first encounters where hp_permille < 500
//     (a "weakened" wild) out of all first encounters per (identity, species_id) pair.
//   - successRate:     fraction of recruit attempts that succeeded.
//   - baitRate:        fraction of recruit attempts where bait_item_id != 0.
//   - recatchRate:     fraction of (identity, species_id) pairs that appear ≥ 2×.
//     (i.e. the player tried to recruit the same species more than once)
// ---------------------------------------------------------------------------

/**
 * Reference implementation of aggregateReport for proof-of-teeth fixture checks.
 * Mirrors the CONTRACT. The real imported version must produce identical results.
 * @param {Array<{kind:number,identity:string,species_id:number,hp_permille:number,bait_item_id:number,success:boolean}>} rows
 * @returns {{weakenFirstRate:number, successRate:number, baitRate:number, recatchRate:number}}
 */
function _refAggregateReport(rows) {
  // Filter to kind=1 (RecruitAttempt) only.
  const r1 = rows.filter((r) => r.kind === 1);
  if (r1.length === 0) {
    return { weakenFirstRate: 0, successRate: 0, baitRate: 0, recatchRate: 0 };
  }

  // successRate: fraction of rows where success===true.
  const successCount = r1.filter((r) => r.success).length;
  const successRate = successCount / r1.length;

  // baitRate: fraction of rows where bait_item_id !== 0.
  const baitCount = r1.filter((r) => r.bait_item_id !== 0).length;
  const baitRate = baitCount / r1.length;

  // weakenFirstRate + recatchRate require grouping by (identity, species_id).
  // Build a map: key = `${identity}:${species_id}` → array of rows.
  const groups = new Map();
  for (const row of r1) {
    const key = `${row.identity}:${row.species_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  // weakenFirstRate: for each (identity, species_id) group, take the FIRST row
  // (by encounter order in the array — already sorted ascending by event_id per spec).
  // Count those where hp_permille < 500.
  let weakenedFirstCount = 0;
  for (const group of groups.values()) {
    if (group[0].hp_permille < 500) weakenedFirstCount++;
  }
  const weakenFirstRate = weakenedFirstCount / groups.size;

  // recatchRate: fraction of (identity, species_id) pairs that appear ≥ 2 times.
  let recatchCount = 0;
  for (const group of groups.values()) {
    if (group.length >= 2) recatchCount++;
  }
  const recatchRate = recatchCount / groups.size;

  return { weakenFirstRate, successRate, baitRate, recatchRate };
}

// ---------------------------------------------------------------------------
// Helper: check that a value is a finite number (not NaN, not Infinity).
// ---------------------------------------------------------------------------
function isFiniteNumber(v) {
  return typeof v === 'number' && isFinite(v);
}

// ---------------------------------------------------------------------------
// Helper: check that an object contains no identity hex string.
// A 64-hex string is a SpacetimeDB Identity serialised as hex.
// We check: no value in the object is a string matching 64 consecutive
// hex characters.  Use a literal regex.
// ---------------------------------------------------------------------------
function containsPiiHex(obj) {
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v)) return true;
    if (typeof v === 'string' && v.indexOf('0x') !== -1 && v.length >= 66) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Proof-of-teeth for the reference aggregateReport
// ---------------------------------------------------------------------------

// Fixture A: empty array → zeroed rates.
const FIXTURE_EMPTY = [];
const EXPECTED_EMPTY = { weakenFirstRate: 0, successRate: 0, baitRate: 0, recatchRate: 0 };

// Fixture B: 4 recruit rows for 2 (identity, species_id) pairs.
//   identity A, species 1: row 1 (hp=400, no bait, fail) + row 2 (hp=600, bait, success)
//   identity B, species 2: row 3 (hp=800, no bait, success)
//   identity A, species 2: row 4 (hp=200, bait, fail)
//
// Hand-computed expected values:
//   successRate   = 2 successes out of 4 rows (row2 + row3) = 0.5
//   baitRate      = 2 rows with bait out of 4 = 0.5
//   groups:
//     (A, 1): [row1, row2] — first.hp=400 < 500 → weakened; len=2 → recatch
//     (B, 2): [row3]       — first.hp=800 >= 500 → NOT weakened; len=1 → no recatch
//     (A, 2): [row4]       — first.hp=200 < 500 → weakened; len=1 → no recatch
//   weakenFirstRate = 2 weakened / 3 groups = 0.6666...
//   recatchRate     = 1 recatch  / 3 groups = 0.3333...
const FIXTURE_B = [
  { kind: 1, identity: 'aaa', species_id: 1, hp_permille: 400, bait_item_id: 0, success: false },
  { kind: 1, identity: 'aaa', species_id: 1, hp_permille: 600, bait_item_id: 7, success: true },
  { kind: 1, identity: 'bbb', species_id: 2, hp_permille: 800, bait_item_id: 0, success: true },
  { kind: 1, identity: 'aaa', species_id: 2, hp_permille: 200, bait_item_id: 3, success: false },
];
const EXPECTED_B = {
  weakenFirstRate: 2 / 3,
  successRate: 2 / 4,
  baitRate: 2 / 4,
  recatchRate: 1 / 3,
};

// Fixture C: rows include a non-RecruitAttempt kind=2 row — must be filtered out.
const FIXTURE_C = [
  { kind: 1, identity: 'ccc', species_id: 5, hp_permille: 800, bait_item_id: 0, success: true },
  { kind: 2, identity: 'ccc', species_id: 5, hp_permille: 0, bait_item_id: 0, success: false }, // ignored
];
// Only 1 kind=1 row: success=true, bait=0, hp=800 (not weakened), 1 group (ccc,5) — not weakened, not recatch.
const EXPECTED_C = {
  weakenFirstRate: 0,
  successRate: 1,
  baitRate: 0,
  recatchRate: 0,
};

// ---------------------------------------------------------------------------
// Default export — eval entry point
// ---------------------------------------------------------------------------

export default async function () {
  const name =
    'playtest-report (pt-b2: aggregateReport pure-fn + justfile recipe + script structural scans)';

  // =========================================================================
  // SECTION 1: PROOF-OF-TEETH FOR REFERENCE PREDICATES
  // =========================================================================

  // ── T1a: empty fixture → zeroed rates, no NaN/Infinity, no throw.
  {
    let result;
    try {
      result = _refAggregateReport(FIXTURE_EMPTY);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH T1a: _refAggregateReport([]) threw: ${e.message}`,
      };
    }
    for (const [key, val] of Object.entries(EXPECTED_EMPTY)) {
      if (result[key] !== val) {
        return {
          name,
          pass: false,
          detail: `TEETH T1a: _refAggregateReport([]) returned ${key}=${result[key]}, expected ${val}`,
        };
      }
    }
    for (const [key, val] of Object.entries(result)) {
      if (!isFiniteNumber(val)) {
        return {
          name,
          pass: false,
          detail: `TEETH T1a: _refAggregateReport([]) returned ${key}=${val} (NaN or Infinity) — empty input must produce zeros`,
        };
      }
    }
  }

  // ── T1b: fixture B → hand-computed rates (exact floating-point equality is fine
  //          for these small rationals).
  {
    let result;
    try {
      result = _refAggregateReport(FIXTURE_B);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH T1b: _refAggregateReport(FIXTURE_B) threw: ${e.message}`,
      };
    }
    const eps = 1e-9;
    for (const [key, expected] of Object.entries(EXPECTED_B)) {
      if (Math.abs(result[key] - expected) > eps) {
        return {
          name,
          pass: false,
          detail: `TEETH T1b: _refAggregateReport(FIXTURE_B) returned ${key}=${result[key]}, expected ${expected} (±${eps}). Hand-computed: successRate=0.5, baitRate=0.5, weakenFirstRate=2/3, recatchRate=1/3.`,
        };
      }
    }
  }

  // ── T1c: fixture C — kind=2 rows filtered out.
  {
    let result;
    try {
      result = _refAggregateReport(FIXTURE_C);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH T1c: _refAggregateReport(FIXTURE_C) threw: ${e.message}`,
      };
    }
    if (result.successRate !== 1) {
      return {
        name,
        pass: false,
        detail: `TEETH T1c: kind=2 row must be filtered out; successRate should be 1 (1 kind=1 success). Got ${result.successRate}`,
      };
    }
    if (result.baitRate !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH T1c: kind=2 row must be filtered out; baitRate should be 0. Got ${result.baitRate}`,
      };
    }
  }

  // ── T1d: PII-firewall — BAD: an object with a 64-hex identity string must be flagged.
  {
    const badObj = {
      weakenFirstRate: 0.5,
      identity: 'a'.repeat(64),
    };
    if (!containsPiiHex(badObj)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1d: containsPiiHex should flag an object with a 64-hex string identity field — PII check is broken',
      };
    }
  }

  // ── T1e: PII-firewall — GOOD: the aggregate result object must NOT be flagged.
  {
    const goodObj = { weakenFirstRate: 0.5, successRate: 0.25, baitRate: 0.5, recatchRate: 0.33 };
    if (containsPiiHex(goodObj)) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1e: containsPiiHex incorrectly flagged a clean aggregate result object — false positive',
      };
    }
  }

  // ── T1f: justfileHasRecipe BAD — recipe absent must return false.
  {
    const jf = 'ci: lint\nlint:\n    cargo fmt --check\n';
    if (justfileHasRecipe(jf, 'playtest-report')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1f: justfileHasRecipe returned true for a justfile with no playtest-report recipe',
      };
    }
  }

  // ── T1g: justfileHasRecipe GOOD — recipe present must return true.
  {
    const jf = 'ci: lint\n\nplaytest-report:\n    node scripts/playtest-report.mjs\n';
    if (!justfileHasRecipe(jf, 'playtest-report')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1g: justfileHasRecipe returned false for a justfile that does contain playtest-report',
      };
    }
  }

  // =========================================================================
  // SECTION 2: DYNAMIC IMPORT OF REAL aggregateReport
  // RED state: scripts/playtest-report.mjs not yet implemented.
  // =========================================================================

  let aggregateReport;
  try {
    const mod = await import('../scripts/playtest-report.mjs');
    aggregateReport = mod.aggregateReport;
    if (typeof aggregateReport !== 'function') {
      return {
        name,
        pass: false,
        detail:
          'scripts/playtest-report.mjs exists but does not export `aggregateReport` as a function — must export the pure aggregation fn',
      };
    }
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `scripts/playtest-report.mjs not yet implemented (import failed: ${e?.message ?? String(e)}) — RED state expected`,
    };
  }

  // =========================================================================
  // SECTION 3: PROOF-OF-TEETH AGAINST THE REAL aggregateReport
  // =========================================================================

  // ── T3a: empty array → zeroed rates, no NaN/Infinity, no throw.
  {
    let result;
    try {
      result = aggregateReport(FIXTURE_EMPTY);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3a: aggregateReport([]) threw: ${e.message}`,
      };
    }
    for (const [key, val] of Object.entries(EXPECTED_EMPTY)) {
      if (result[key] !== val) {
        return {
          name,
          pass: false,
          detail: `TEETH (real) T3a: aggregateReport([]) returned ${key}=${result[key]}, expected ${val}`,
        };
      }
    }
    for (const [key, val] of Object.entries(result)) {
      if (!isFiniteNumber(val)) {
        return {
          name,
          pass: false,
          detail: `TEETH (real) T3a: aggregateReport([]) returned non-finite ${key}=${val} — empty input must produce zeros, not NaN/Infinity`,
        };
      }
    }
  }

  // ── T3b: fixture B → correct hand-computed rates.
  {
    let result;
    try {
      result = aggregateReport(FIXTURE_B);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3b: aggregateReport(FIXTURE_B) threw: ${e.message}`,
      };
    }
    const eps = 1e-9;
    for (const [key, expected] of Object.entries(EXPECTED_B)) {
      if (Math.abs(result[key] - expected) > eps) {
        return {
          name,
          pass: false,
          detail: `TEETH (real) T3b: aggregateReport(FIXTURE_B) ${key}=${result[key]}, expected ${expected}. Fixture: 4 rows, 3 (identity,species) groups. Hand-computed: successRate=0.5, baitRate=0.5, weakenFirstRate=2/3, recatchRate=1/3.`,
        };
      }
    }
  }

  // ── T3c: fixture C — kind=2 rows filtered.
  {
    let result;
    try {
      result = aggregateReport(FIXTURE_C);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3c: aggregateReport(FIXTURE_C) threw: ${e.message}`,
      };
    }
    if (result.successRate !== 1) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3c: kind=2 row not filtered; successRate=${result.successRate} (expected 1). Script must filter kind === 1 only.`,
      };
    }
  }

  // ── T3d: PII-firewall — result must contain no 64-hex identity string.
  {
    // Use a row with a realistic hex identity string — aggregateReport should
    // NOT surface it in the return value (it must aggregate, not relay raw rows).
    const hexIdentity = 'b'.repeat(64);
    const piiFixture = [
      {
        kind: 1,
        identity: hexIdentity,
        species_id: 1,
        hp_permille: 300,
        bait_item_id: 0,
        success: true,
      },
    ];
    let result;
    try {
      result = aggregateReport(piiFixture);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3d: aggregateReport(piiFixture) threw: ${e.message}`,
      };
    }
    if (containsPiiHex(result)) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3d: aggregateReport return value contains a 64-hex identity string — PII firewall violated. The return object must aggregate to rates only, never relay raw identity values. Got: ${JSON.stringify(result)}`,
      };
    }
  }

  // =========================================================================
  // SECTION 4: STRUCTURAL SCANS — justfile + script
  // =========================================================================

  const root = path.resolve('.');
  const justfilePath = path.join(root, 'justfile');
  const reportScriptPath = path.join(root, 'scripts/playtest-report.mjs');

  // ── 4.1: justfile has `playtest-report` recipe.
  let justfile;
  try {
    justfile = readFileSync(justfilePath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read justfile' };
  }

  if (!justfileHasRecipe(justfile, 'playtest-report')) {
    return {
      name,
      pass: false,
      detail: 'justfile missing recipe "playtest-report" — implementer must add it (pt-b2)',
    };
  }

  // ── 4.2: script exists and is non-trivial.
  if (!existsSync(reportScriptPath)) {
    return {
      name,
      pass: false,
      detail: 'scripts/playtest-report.mjs does not exist — implementer must create it',
    };
  }
  const scriptSrc = readFileSync(reportScriptPath, 'utf8');
  if (scriptSrc.trim().length < 100) {
    return {
      name,
      pass: false,
      detail:
        'scripts/playtest-report.mjs is trivially short (< 100 chars) — must be a real implementation',
    };
  }

  const scriptStripped = stripMjsComments(scriptSrc);

  // ── 4.3: script exports `aggregateReport`.
  if (!scriptSrc.includes('aggregateReport')) {
    return {
      name,
      pass: false,
      detail:
        'scripts/playtest-report.mjs does not contain the name "aggregateReport" — must export the pure aggregation function',
    };
  }

  // ── 4.4: script uses `execFileSync` (array-args), not string-interpolated shell.
  // execFileSync with an array avoids shell injection via the DB name argument.
  if (!scriptStripped.includes('execFileSync')) {
    return {
      name,
      pass: false,
      detail:
        'scripts/playtest-report.mjs does not use execFileSync — must use execFileSync(cmd, argsArray) to avoid shell-string injection of spacetime sql arguments',
    };
  }

  // Negative: must NOT contain a shell-string spacetime sql interpolation.
  // The forbidden pattern: `spacetime sql` embedded in a template literal or string concat.
  // We look for the literal substring "spacetime sql" in the comment-stripped source —
  // if it appears OUTSIDE of an execFileSync args array, it is a shell injection risk.
  // The safe form passes ["spacetime", "sql", ...] as separate array elements.
  // The check: "spacetime sql" as a single string (with a space) in the stripped source
  // indicates a shell string.  Safe calls use separate array elements and would not
  // have the two words joined in a single string token.
  // We check the stripped source to exclude comment-only appearances.
  if (scriptStripped.includes('spacetime sql')) {
    return {
      name,
      pass: false,
      detail:
        'scripts/playtest-report.mjs contains the shell string "spacetime sql" — must pass spacetime and sql as separate array elements to execFileSync, not as a single shell string',
    };
  }

  // ── 4.5: script has a process.exit(1) fail-loud path.
  if (!scriptStripped.includes('process.exit(1)')) {
    return {
      name,
      pass: false,
      detail:
        'scripts/playtest-report.mjs does not contain process.exit(1) — must fail loud (non-zero exit) when spacetime sql fails or output is empty',
    };
  }

  // ── 4.6: script filters kind === 1 (only RecruitAttempt events).
  // We check that "kind === 1" or "kind==1" appears in the stripped source.
  const hasKindFilter = scriptStripped.includes('kind === 1') || scriptStripped.includes('kind==1');
  if (!hasKindFilter) {
    return {
      name,
      pass: false,
      detail:
        'scripts/playtest-report.mjs does not contain "kind === 1" or "kind==1" — must filter to RecruitAttempt (kind=1) events only before aggregating',
    };
  }

  // ── 4.7: SQL query includes ORDER BY event_id (PT-B2-RT-01: weakenFirstRate ordering invariant).
  // aggregateReport uses group[0] as the "first encounter" per (identity, species_id) pair
  // for weakenFirstRate.  Without ORDER BY event_id ASC the row order returned by spacetime sql
  // is implementation-defined; group[0] could be the NEWEST not the OLDEST attempt, making
  // weakenFirstRate non-deterministic and wrong.  The H1 hypothesis measurement depends on
  // "first encounter" being chronologically the lowest event_id.
  //
  // Kills: impl that relies on the DB returning rows in PK order without making it explicit
  // in the SQL query (non-portable, non-guaranteed behaviour).
  if (
    !scriptStripped.includes('ORDER BY event_id') &&
    !scriptStripped.includes('order by event_id')
  ) {
    return {
      name,
      pass: false,
      detail:
        'scripts/playtest-report.mjs SQL query does not contain "ORDER BY event_id" — ' +
        'weakenFirstRate uses group[0] as the first encounter per (identity,species_id) pair; ' +
        'without ORDER BY event_id ASC the row order is implementation-defined and group[0] ' +
        'may be the newest rather than the oldest attempt, making weakenFirstRate non-deterministic. ' +
        'Fix: append "ORDER BY event_id ASC" to the SELECT query (PT-B2-RT-01).',
    };
  }

  // =========================================================================
  // ALL CHECKS PASSED
  // =========================================================================

  return {
    name,
    pass: true,
    detail: [
      'All pt-b2 playtest-report criteria satisfied:',
      'aggregateReport pure-fn teeth: empty→zeros (no NaN), fixture-B hand-computed rates (successRate=0.25 baitRate=0.5 weakenFirstRate=2/3 recatchRate=1/3), kind=2 filtered, PII-firewall (no hex identity in return);',
      'justfile: playtest-report recipe present;',
      'script: exists, non-trivial, exports aggregateReport, uses execFileSync (no shell-string), has process.exit(1), filters kind===1, SQL query has ORDER BY event_id (PT-B2-RT-01).',
    ].join(' '),
  };
}
