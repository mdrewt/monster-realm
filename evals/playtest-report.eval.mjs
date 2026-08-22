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
//   9. script consumes `spacetime sql --format json` (pinned 2.8.1 CLI), decoding
//      via an exported pure `decodeSqlJson(stdout) -> Array<row objects>` that
//      zips the positional `rows` arrays against `schema.elements` order — the
//      OLD pipe-table parser (`parseSqlTable`) is deleted outright, no fallback.
//  10. `coerceRow` is fail-loud (throws on malformed/short/mistyped raw rows,
//      never silently produces NaN) and unwraps the one-element Identity array
//      to a bare hex string.
//
// IMPORTANT: NO new RegExp() anywhere — Semgrep detect-non-literal-regexp.
// Only literal regex and String methods (indexOf / includes / startsWith / split).
//
// All proof-of-teeth for pure predicates run UNCONDITIONALLY before real scans.
//
// RED STATE TODAY: scripts/playtest-report.mjs exists but does not export
// `decodeSqlJson` (it still only exports the old `parseSqlTable` pipe-table
// parser) → the Section 2 dynamic-import export-surface check fails with
// "does not export decodeSqlJson" → pass:false. This is a real-shape RED
// (missing export), not an import crash.

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
// GROUND-TRUTH FIXTURES — captured VERBATIM from the pinned 2.8.1 `spacetime`
// CLI on a live standalone instance, 2026-08-22, querying the real
// `playtest_event` table with `--format json`. Do NOT hand-edit these strings.
//
// Capture command:
//   spacetime sql -s http://127.0.0.1:3099 --format json mr16rd-probe \
//     'SELECT event_id, kind, identity, species_id, hp_permille, bait_item_id, success FROM playtest_event'
//
// Envelope shape (verified, not assumed): top level is an ARRAY of statement
// results; `rows` are POSITIONAL arrays aligned to `schema.elements` ORDER,
// not name-keyed objects; column names live at `schema.elements[i].name.some`
// (Option-encoded — an unnamed column is `{"none":{}}`); integers arrive as
// bare JSON numbers, `bool` as a real JSON boolean; Identity is a ONE-ELEMENT
// ARRAY holding the hex string.
//
// The 4-row fixture's useful properties: rows arrive OUT OF event_id order
// (10, 30, 20, 40) proving sortByEventId is load-bearing; two distinct
// identities (0xc200.../0xb100...); both `success` values appear; one
// `kind === 2` row (event_id 40) that must be filtered out by aggregateReport;
// `bait_item_id` is 42 on exactly one row (event_id 30).
// ---------------------------------------------------------------------------
const GROUND_TRUTH_JSON =
  '[{"schema":{"elements":[{"name":{"some":"event_id"},"algebraic_type":{"U64":[]}},{"name":{"some":"kind"},"algebraic_type":{"U16":[]}},{"name":{"some":"identity"},"algebraic_type":{"Product":{"elements":[{"name":{"some":"__identity__"},"algebraic_type":{"U256":[]}}]}}},{"name":{"some":"species_id"},"algebraic_type":{"U32":[]}},{"name":{"some":"hp_permille"},"algebraic_type":{"U16":[]}},{"name":{"some":"bait_item_id"},"algebraic_type":{"U32":[]}},{"name":{"some":"success"},"algebraic_type":{"Bool":[]}}]},"rows":[[10,1,["0xc20081c5a6e7ac231130aae44dd6ed6215bb09537a4ce925da87f1afed767da6"],7,300,0,true],[30,1,["0xc20081c5a6e7ac231130aae44dd6ed6215bb09537a4ce925da87f1afed767da6"],7,900,42,false],[20,1,["0xb10081c5a6e7ac231130aae44dd6ed6215bb09537a4ce925da87f1afed76700f"],9,200,0,true],[40,2,["0xb10081c5a6e7ac231130aae44dd6ed6215bb09537a4ce925da87f1afed76700f"],9,500,0,false]],"total_duration_micros":316,"stats":{"rows_inserted":0,"rows_deleted":0,"rows_updated":0}}]';

const GROUND_TRUTH_EMPTY_JSON =
  '[{"schema":{"elements":[{"name":{"some":"event_id"},"algebraic_type":{"U64":[]}},{"name":{"some":"kind"},"algebraic_type":{"U16":[]}},{"name":{"some":"identity"},"algebraic_type":{"Product":{"elements":[{"name":{"some":"__identity__"},"algebraic_type":{"U256":[]}}]}}},{"name":{"some":"species_id"},"algebraic_type":{"U32":[]}},{"name":{"some":"hp_permille"},"algebraic_type":{"U16":[]}},{"name":{"some":"bait_item_id"},"algebraic_type":{"U32":[]}},{"name":{"some":"success"},"algebraic_type":{"Bool":[]}}]},"rows":[],"total_duration_micros":302,"stats":{"rows_inserted":0,"rows_deleted":0,"rows_updated":0}}]';

// ---------------------------------------------------------------------------
// Data-driven MUST-THROW cases for decodeSqlJson, derived by mutating a fresh
// parse of GROUND_TRUTH_JSON per case (never sharing mutable state across
// cases). Each one must make decodeSqlJson throw; if any does not, the eval
// reports exactly which case failed to bite.
// ---------------------------------------------------------------------------
function buildMustThrowCases() {
  const cases = [];

  cases.push({ label: 'non-JSON stdout', stdout: 'not json at all' });
  cases.push({ label: 'empty stdout', stdout: '' });
  cases.push({ label: 'non-array top level ({})', stdout: '{}' });
  cases.push({ label: 'zero statement results ([]) — the envelope[0]?.rows ?? [] trap', stdout: '[]' });

  const first = JSON.parse(GROUND_TRUTH_JSON)[0];
  cases.push({
    label: 'two-element top-level array (more than one statement result)',
    stdout: JSON.stringify([first, JSON.parse(GROUND_TRUTH_JSON)[0]]),
  });

  const noElements = JSON.parse(GROUND_TRUTH_JSON);
  delete noElements[0].schema.elements;
  cases.push({ label: 'schema.elements missing entirely', stdout: JSON.stringify(noElements) });

  const emptyElements = JSON.parse(GROUND_TRUTH_JSON);
  emptyElements[0].schema.elements = [];
  cases.push({
    label: 'schema.elements: [] with a non-empty rows array',
    stdout: JSON.stringify(emptyElements),
  });

  const unnamedColumn = JSON.parse(GROUND_TRUTH_JSON);
  unnamedColumn[0].schema.elements[0].name = { none: {} };
  cases.push({
    label: 'a column whose name is {"none":{}} (unnamed column)',
    stdout: JSON.stringify(unnamedColumn),
  });

  const dupeNames = JSON.parse(GROUND_TRUTH_JSON);
  dupeNames[0].schema.elements[1].name = { some: dupeNames[0].schema.elements[0].name.some };
  cases.push({ label: 'duplicate column names across elements', stdout: JSON.stringify(dupeNames) });

  const rowsMissing = JSON.parse(GROUND_TRUTH_JSON);
  delete rowsMissing[0].rows;
  cases.push({ label: 'rows missing', stdout: JSON.stringify(rowsMissing) });

  const rowsNotArray = JSON.parse(GROUND_TRUTH_JSON);
  rowsNotArray[0].rows = 'nope';
  cases.push({ label: 'rows not an array', stdout: JSON.stringify(rowsNotArray) });

  const rowNotArray = JSON.parse(GROUND_TRUTH_JSON);
  rowNotArray[0].rows[0] = { event_id: 10 };
  cases.push({ label: 'a row that is not an array (e.g. an object)', stdout: JSON.stringify(rowNotArray) });

  // Arity mismatch: `rows` is present and well-formed as an array-of-arrays,
  // but ONE row has fewer elements than schema.elements.length (7 columns,
  // 5-element row here). This is the critical must-throw case: a positional
  // zip over a short row leaves bait_item_id===undefined, Number(undefined)
  // ===NaN, and aggregateReport counts bait via `bait_item_id !== 0` — NaN
  // !== 0 is TRUE — so a silently-accepted truncated row INFLATES baitRate
  // with no error anywhere in the pipeline. This case must never be deleted
  // as "pedantic": it is the one guard standing between a CLI/schema drift
  // and a silently wrong H2 bait-rate metric.
  const arityMismatch = JSON.parse(GROUND_TRUTH_JSON);
  arityMismatch[0].rows[0] = arityMismatch[0].rows[0].slice(0, 5);
  cases.push({
    label:
      'arity mismatch: 7 columns but a 5-element row — a positional zip leaves bait_item_id===undefined, ' +
      'Number(undefined)===NaN, and aggregateReport counts bait via bait_item_id!==0 where NaN!==0 is TRUE, ' +
      'so a truncated row silently INFLATES baitRate with no error',
    stdout: JSON.stringify(arityMismatch),
  });

  return cases;
}

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
  // SECTION 2: DYNAMIC IMPORT OF REAL EXPORTS
  // RED state: scripts/playtest-report.mjs does not export decodeSqlJson yet
  // (it still only has the old parseSqlTable pipe-table parser).
  // =========================================================================

  let aggregateReport, sortByEventId, decodeSqlJson, coerceRow;
  try {
    const mod = await import('../scripts/playtest-report.mjs');
    aggregateReport = mod.aggregateReport;
    sortByEventId = mod.sortByEventId;
    decodeSqlJson = mod.decodeSqlJson;
    coerceRow = mod.coerceRow;
    if (typeof aggregateReport !== 'function') {
      return {
        name,
        pass: false,
        detail:
          'scripts/playtest-report.mjs exists but does not export `aggregateReport` as a function — must export the pure aggregation fn',
      };
    }
    if (typeof sortByEventId !== 'function') {
      return {
        name,
        pass: false,
        detail:
          'scripts/playtest-report.mjs does not export `sortByEventId` — SpacetimeDB 2.8.1 (re-verified 2026-08-22) SQL rejects ORDER BY, so the group[0]="first encounter" ordering (PT-B2-RT-01) must be enforced client-side by an exported, independently-testable pure fn.',
      };
    }
    if (typeof decodeSqlJson !== 'function') {
      return {
        name,
        pass: false,
        detail:
          'scripts/playtest-report.mjs does not export `decodeSqlJson` — the pinned 2.8.1 `spacetime` CLI ' +
          'has a `--format json` mode that prints the raw response body as an array of statement results; ' +
          '`rows` arrive as POSITIONAL arrays aligned to `schema.elements` order (not name-keyed objects), ' +
          'so the decoder must zip each row against the schema column order into a keyed row object. ' +
          'The old pipe-table `parseSqlTable` parser must be deleted, not kept as a fallback.',
      };
    }
    if (typeof coerceRow !== 'function') {
      return {
        name,
        pass: false,
        detail:
          'scripts/playtest-report.mjs does not export `coerceRow` — must export the fail-loud row coercer ' +
          'that unwraps the one-element Identity array to a bare hex string and validates the decoded row shape.',
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
  // SECTION 3: PROOF-OF-TEETH AGAINST THE REAL aggregateReport / sortByEventId
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

  // ── T3e: sortByEventId — out-of-order input must come back ascending by event_id,
  //         and group[0] after grouping must be the OLDEST row, not just any row.
  //         This is a functional proof of PT-B2-RT-01 (unlike a source-text scan for
  //         "ORDER BY event_id", which the pre-fix eval used and which proved nothing:
  //         SpacetimeDB 2.8.1 (re-verified 2026-08-22) silently rejects that SQL
  //         clause with a 400 Bad Request).
  {
    const OUT_OF_ORDER = [
      {
        event_id: 30,
        kind: 1,
        identity: 'x',
        species_id: 1,
        hp_permille: 900,
        bait_item_id: 0,
        success: true,
      },
      {
        event_id: 10,
        kind: 1,
        identity: 'x',
        species_id: 1,
        hp_permille: 200,
        bait_item_id: 0,
        success: false,
      },
      {
        event_id: 20,
        kind: 1,
        identity: 'x',
        species_id: 1,
        hp_permille: 500,
        bait_item_id: 0,
        success: true,
      },
    ];
    let sorted;
    try {
      sorted = sortByEventId(OUT_OF_ORDER);
    } catch (e) {
      return { name, pass: false, detail: `TEETH (real) T3e: sortByEventId threw: ${e.message}` };
    }
    const ids = sorted.map((r) => r.event_id);
    if (ids[0] !== 10 || ids[1] !== 20 || ids[2] !== 30) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3e: sortByEventId did not produce ascending event_id order. Got [${ids.join(',')}], expected [10,20,30].`,
      };
    }
    // Must not mutate the input array (aggregateReport's caller re-uses rawRows elsewhere).
    if (OUT_OF_ORDER[0].event_id !== 30) {
      return {
        name,
        pass: false,
        detail:
          'TEETH (real) T3e: sortByEventId mutated its input array in place — must return a new sorted array.',
      };
    }
    // End-to-end: feeding the sorted rows through aggregateReport must treat event_id=10
    // (hp=200, weakened) as the "first encounter", not event_id=30 (hp=900, not weakened).
    const report = aggregateReport(sorted);
    if (report.weakenFirstRate !== 1) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3e: after sortByEventId, aggregateReport's group[0] was not the lowest event_id — weakenFirstRate=${report.weakenFirstRate}, expected 1 (event_id=10, hp=200 < 500, must be treated as first).`,
      };
    }
  }

  // =========================================================================
  // SECTION 3 (continued): decodeSqlJson TEETH — replaces the old
  // parseSqlTable pipe-table teeth (T3f/T3g/T3h) entirely.
  // =========================================================================

  // ── T3f: well-formed decode. The 4-row capture arrives out of event_id order
  //         (10, 30, 20, 40); decodeSqlJson must NOT reorder — that is
  //         sortByEventId's job — it must only zip rows against schema order.
  {
    let decoded;
    try {
      decoded = decodeSqlJson(GROUND_TRUTH_JSON);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3f: decodeSqlJson threw on the verbatim well-formed capture: ${e.message}`,
      };
    }
    if (!Array.isArray(decoded) || decoded.length !== 4) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3f: decodeSqlJson must return 4 row objects for the 4-row capture, got: ${JSON.stringify(decoded)}`,
      };
    }
    const expectedEventIds = [10, 30, 20, 40];
    for (let i = 0; i < 4; i++) {
      if (decoded[i].event_id !== expectedEventIds[i]) {
        return {
          name,
          pass: false,
          detail: `TEETH (real) T3f: decodeSqlJson row[${i}].event_id=${decoded[i].event_id}, expected ${expectedEventIds[i]} — rows must stay in POSITIONAL order (10,30,20,40), decodeSqlJson must not sort.`,
        };
      }
    }
    if (typeof decoded[0].event_id !== 'number') {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3f: decoded event_id must be a JSON number (typeof 'number'), got typeof ${typeof decoded[0].event_id}`,
      };
    }
    if (typeof decoded[0].success !== 'boolean' || decoded[0].success !== true) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3f: decoded row[0].success must be the real boolean true (typeof 'boolean'), got ${typeof decoded[0].success} ${decoded[0].success} — NOT the string 'true'.`,
      };
    }
    if (!Array.isArray(decoded[0].identity) || decoded[0].identity.length !== 1) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3f: decoded row[0].identity must still be the one-element Identity array (decoding does not unwrap — that is coerceRow's job). Got: ${JSON.stringify(decoded[0].identity)}`,
      };
    }
    if (decoded[1].event_id !== 30 || decoded[1].bait_item_id !== 42) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3f: the event_id=30 row must have bait_item_id===42, got event_id=${decoded[1].event_id} bait_item_id=${decoded[1].bait_item_id}`,
      };
    }
  }

  // ── T3g: valid-empty capture → [], no throw.
  {
    let decoded;
    try {
      decoded = decodeSqlJson(GROUND_TRUTH_EMPTY_JSON);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3g: decodeSqlJson threw on the verbatim valid-empty capture: ${e.message}`,
      };
    }
    if (!Array.isArray(decoded) || decoded.length !== 0) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3g: decodeSqlJson on a valid zero-row capture must return [], got ${JSON.stringify(decoded)}`,
      };
    }
  }

  // ── T3h: data-driven must-throw table (12 cases, including the arity-
  //         mismatch case whose failure message names the NaN-inflates-
  //         baitRate consequence — see buildMustThrowCases() above). Each
  //         case reports individually so a single missing guard is
  //         diagnosable, not lost in a generic failure.
  {
    const cases = buildMustThrowCases();
    for (const { label, stdout } of cases) {
      let threw = false;
      try {
        decodeSqlJson(stdout);
      } catch {
        threw = true;
      }
      if (!threw) {
        return {
          name,
          pass: false,
          detail: `TEETH (real) T3h[${label}]: decodeSqlJson did NOT throw — must fail loud on this malformed envelope shape.`,
        };
      }
    }
  }

  // ── T3i: prototype safety. A column literally named "__proto__" must not
  //         corrupt the produced row object. A naive `row[col] = value` on a
  //         plain `{}` object SILENTLY DROPS the value for `__proto__` (it is
  //         an accessor on Object.prototype, and assigning a non-object to it
  //         is a silent no-op) — the correct implementation uses
  //         Object.create(null) or Object.defineProperty so the value is a
  //         real own property.
  {
    const protoEnvelope = JSON.parse(GROUND_TRUTH_JSON);
    protoEnvelope[0].schema.elements[0].name = { some: '__proto__' };
    protoEnvelope[0].rows = [[999, 1, ['0xabc'], 7, 300, 0, true]];
    let decoded;
    try {
      decoded = decodeSqlJson(JSON.stringify(protoEnvelope));
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3i: decodeSqlJson threw on a column literally named "__proto__": ${e.message}`,
      };
    }
    const row = decoded[0];
    if (!Object.prototype.hasOwnProperty.call(row, '__proto__')) {
      return {
        name,
        pass: false,
        detail:
          'TEETH (real) T3i: a "__proto__"-named column value was silently dropped (not an own property) — ' +
          'this is the classic prototype-pollution trap of `row[col] = value` on a plain {} object; the ' +
          'decoder must build rows with Object.create(null) or Object.defineProperty.',
      };
    }
    if (row['__proto__'] !== 999) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3i: row['__proto__'] must read back as 999, got ${JSON.stringify(row['__proto__'])}`,
      };
    }
  }

  // =========================================================================
  // SECTION 3 (continued): coerceRow TEETH — none existed before this slice.
  // ========================================================================

  // ── T3j: Identity unwrapping — a one-element array becomes a bare hex string.
  {
    const raw = {
      event_id: 10,
      kind: 1,
      identity: ['0xc20081c5a6e7ac231130aae44dd6ed6215bb09537a4ce925da87f1afed767da6'],
      species_id: 7,
      hp_permille: 300,
      bait_item_id: 0,
      success: true,
    };
    let coerced;
    try {
      coerced = coerceRow(raw);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3j: coerceRow threw on a well-formed one-element Identity row: ${e.message}`,
      };
    }
    if (
      typeof coerced.identity !== 'string' ||
      coerced.identity.indexOf('0x') !== 0 ||
      coerced.identity.length !== 66
    ) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3j: coerceRow must unwrap a one-element Identity array to a bare 66-char '0x'-prefixed hex string, got: ${JSON.stringify(coerced.identity)}`,
      };
    }
  }

  // ── T3k: a TWO-element identity array must throw. String(["a","b"]) yields
  //         "a,b", which would silently MERGE two distinct players into one
  //         `${identity}:${species_id}` aggregation group key.
  {
    const raw = {
      event_id: 10,
      kind: 1,
      identity: ['a', 'b'],
      species_id: 7,
      hp_permille: 300,
      bait_item_id: 0,
      success: true,
    };
    let threw = false;
    try {
      coerceRow(raw);
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH (real) T3k: coerceRow did NOT throw on a two-element Identity array — String(["a","b"]) === ' +
          '"a,b" would silently merge two distinct identities into one aggregation group key.',
      };
    }
  }

  // ── T3l: a missing required key must throw — otherwise NaN !== 0 silently
  //         inflates baitRate (same trap as the decodeSqlJson arity-mismatch case).
  {
    const raw = {
      event_id: 10,
      kind: 1,
      identity: ['0xc20081c5a6e7ac231130aae44dd6ed6215bb09537a4ce925da87f1afed767da6'],
      species_id: 7,
      hp_permille: 300,
      // bait_item_id intentionally dropped
      success: true,
    };
    let threw = false;
    try {
      coerceRow(raw);
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          'TEETH (real) T3l: coerceRow did NOT throw on a row missing bait_item_id — Number(undefined)===NaN ' +
          'and NaN!==0 silently inflates baitRate with no error.',
      };
    }
  }

  // ── T3m: a non-finite numeric field must throw.
  {
    const raw = {
      event_id: 10,
      kind: 1,
      identity: ['0xc20081c5a6e7ac231130aae44dd6ed6215bb09537a4ce925da87f1afed767da6'],
      species_id: 7,
      hp_permille: 'abc',
      bait_item_id: 0,
      success: true,
    };
    let threw = false;
    try {
      coerceRow(raw);
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail: 'TEETH (real) T3m: coerceRow did NOT throw on hp_permille: "abc" (Number("abc") === NaN).',
      };
    }
  }

  // ── T3n: success as the STRING 'true' must throw. Under --format json,
  //         `success` is a real boolean; accepting the old text-era tolerance
  //         would mask a shape change silently.
  {
    const raw = {
      event_id: 10,
      kind: 1,
      identity: ['0xc20081c5a6e7ac231130aae44dd6ed6215bb09537a4ce925da87f1afed767da6'],
      species_id: 7,
      hp_permille: 300,
      bait_item_id: 0,
      success: 'true',
    };
    let threw = false;
    try {
      coerceRow(raw);
    } catch {
      threw = true;
    }
    if (!threw) {
      return {
        name,
        pass: false,
        detail:
          "TEETH (real) T3n: coerceRow did NOT throw on success: 'true' (the STRING) — under --format json " +
          'success is always a real boolean; accepting the string would mask a CLI shape regression.',
      };
    }
  }

  // ── T3o: round-trip — decodeSqlJson → coerceRow → sortByEventId →
  //         aggregateReport over the full 4-row capture reproduces the
  //         hand-computed rates.
  //
  //         Hand computation: only kind===1 rows count, leaving 3 rows
  //         (event_id 40 is kind===2, dropped):
  //           event 10: identity A, species 7, hp=300, bait=0,  success=true
  //           event 30: identity A, species 7, hp=900, bait=42, success=false
  //           event 20: identity B, species 9, hp=200, bait=0,  success=true
  //         successRate = 2 successes (10, 20) / 3 rows           = 2/3
  //         baitRate    = 1 row with bait!=0 (30)   / 3 rows      = 1/3
  //         After sortByEventId ascending: [10, 20, 30]. Groups by
  //         `${identity}:${species_id}`, built by iterating that sorted order:
  //           A:7 = [event10, event30]  (len 2 → recatch)
  //           B:9 = [event20]           (len 1 → no recatch)
  //         weakenFirstRate: group[0] of A:7 is event10 (hp=300<500 → weakened);
  //           group[0] of B:9 is event20 (hp=200<500 → weakened).
  //           weakenFirstRate = 2 weakened / 2 groups = 1
  //         recatchRate = 1 group with len>=2 (A:7) / 2 groups = 0.5
  //
  //         NOTE (discriminating power): a report of exactly 1.0 here is
  //         necessary but not sufficient — the SAME 1.0 also results if
  //         ordering were ignored entirely for group B:9 (single-row group,
  //         "first" is trivial), and even for A:7, group[0] must specifically
  //         be event10 (hp=300, weakened) and NOT event30 (hp=900, NOT
  //         weakened) for the correct value to hold — a shuffled/unsorted
  //         merge could still land on hp=300 by chance for a 2-row group.
  //         T3o' below closes that gap by re-running the SAME rows in
  //         REVERSE decode order and asserting sortByEventId still recovers
  //         weakenFirstRate===1, and T3o'' adds a small hand-written fixture
  //         where the correct rate is strictly between 0 and 1, so neither
  //         "always compute 1" nor "always compute 0" can pass by accident.
  {
    let decoded, coerced, sorted, report;
    try {
      decoded = decodeSqlJson(GROUND_TRUTH_JSON);
      coerced = decoded.map(coerceRow);
      sorted = sortByEventId(coerced);
      report = aggregateReport(sorted);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3o: full decodeSqlJson→coerceRow→sortByEventId→aggregateReport round-trip threw: ${e.message}`,
      };
    }
    const eps = 1e-9;
    const expected = { successRate: 2 / 3, baitRate: 1 / 3, weakenFirstRate: 1, recatchRate: 0.5 };
    for (const [key, val] of Object.entries(expected)) {
      if (Math.abs(report[key] - val) > eps) {
        return {
          name,
          pass: false,
          detail: `TEETH (real) T3o: round-trip ${key}=${report[key]}, expected ${val} (±${eps}). Hand-computed from the 4-row capture: successRate=2/3, baitRate=1/3, weakenFirstRate=1, recatchRate=0.5.`,
        };
      }
    }
  }

  // ── T3o' (ordering-sensitive discriminator): re-run the SAME 4-row capture
  //         but reverse the coerced rows' array order BEFORE sortByEventId,
  //         so a broken/no-op sortByEventId would feed aggregateReport
  //         group[0]=event30 (hp=900, NOT weakened) instead of event10
  //         (hp=300, weakened) for the A:7 group, flipping weakenFirstRate to
  //         1/2=0.5. A correct sortByEventId recovers ascending order
  //         regardless of input order, so this must STILL equal 1.
  {
    let decoded, coerced, reversed, sorted, report;
    try {
      decoded = decodeSqlJson(GROUND_TRUTH_JSON);
      coerced = decoded.map(coerceRow);
      reversed = [...coerced].reverse();
      sorted = sortByEventId(reversed);
      report = aggregateReport(sorted);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3o': reverse-order round-trip threw: ${e.message}`,
      };
    }
    if (report.weakenFirstRate !== 1) {
      return {
        name,
        pass: false,
        detail:
          `TEETH (real) T3o': feeding the 4-row capture through decodeSqlJson→coerceRow in REVERSED array ` +
          `order still must yield weakenFirstRate===1 after sortByEventId (group A:7's first-by-event_id ` +
          `member is event_id=10, hp=300<500, regardless of input array order) — got ${report.weakenFirstRate}. ` +
          `A no-op or broken sortByEventId would instead let event_id=30 (hp=900, NOT weakened) land as ` +
          `group[0], producing 0.5.`,
      };
    }
  }

  // ── T3o'' (strictly-between-0-and-1 fixture): a small hand-written fixture
  //         (not the wire-format capture — this tests aggregate arithmetic,
  //         not JSON decoding) with TWO (identity,species) groups where only
  //         ONE first-encounter is weakened, so neither "always return 1"
  //         nor "always return 0" can pass this tooth.
  //
  //         Hand computation:
  //           group P:1 = [ {event_id:1,hp=250}, {event_id:2,hp=999} ]
  //             → group[0] hp=250 < 500 → weakened
  //           group Q:2 = [ {event_id:3,hp=700} ]
  //             → group[0] hp=700 >= 500 → NOT weakened
  //           weakenFirstRate = 1 weakened / 2 groups = 0.5 (strictly between 0 and 1)
  {
    const BETWEEN_FIXTURE = [
      { event_id: 2, kind: 1, identity: 'p', species_id: 1, hp_permille: 999, bait_item_id: 0, success: true },
      { event_id: 1, kind: 1, identity: 'p', species_id: 1, hp_permille: 250, bait_item_id: 0, success: false },
      { event_id: 3, kind: 1, identity: 'q', species_id: 2, hp_permille: 700, bait_item_id: 0, success: true },
    ];
    let sorted, report;
    try {
      sorted = sortByEventId(BETWEEN_FIXTURE);
      report = aggregateReport(sorted);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3o'': BETWEEN_FIXTURE round-trip threw: ${e.message}`,
      };
    }
    if (report.weakenFirstRate !== 0.5) {
      return {
        name,
        pass: false,
        detail: `TEETH (real) T3o'': weakenFirstRate=${report.weakenFirstRate}, expected exactly 0.5 (1 weakened first-encounter / 2 groups) — this fixture is strictly between 0 and 1 so a hard-coded 0 or 1 return cannot pass it.`,
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

  // ── 4.4c: positive — the driver invokes `--format json` as SEPARATE quoted
  // array elements (guard against a joined '--format json' single-string arg,
  // which execFileSync would pass through as one literal CLI token spacetime
  // would not recognise).
  const hasQuotedFormatFlag =
    scriptStripped.includes("'--format'") || scriptStripped.includes('"--format"');
  const hasQuotedJsonToken = scriptStripped.includes("'json'") || scriptStripped.includes('"json"');
  const hasJoinedFormatJson =
    scriptStripped.includes("'--format json'") || scriptStripped.includes('"--format json"');
  if (!hasQuotedFormatFlag || !hasQuotedJsonToken || hasJoinedFormatJson) {
    return {
      name,
      pass: false,
      detail:
        "scripts/playtest-report.mjs must pass '--format' and 'json' as SEPARATE quoted array elements to " +
        "execFileSync (not a joined '--format json' single string) — the pinned 2.8.1 CLI requires them as " +
        'distinct argv entries.',
    };
  }

  // ── 4.4d: positive — the output is actually decoded via JSON.parse(, not just
  // flag-passed-and-ignored ("added the flag, ignored the output").
  if (!scriptStripped.includes('JSON.parse(')) {
    return {
      name,
      pass: false,
      detail:
        'scripts/playtest-report.mjs does not call JSON.parse( — passing --format json is useless unless the ' +
        'stdout is actually decoded as JSON (decodeSqlJson must parse it).',
    };
  }

  // ── 4.4e: negative — the old pipe-table parser must be gone entirely, no
  // vestigial second parser and no text-format fallback path.
  if (scriptStripped.includes('parseSqlTable')) {
    return {
      name,
      pass: false,
      detail:
        'scripts/playtest-report.mjs still contains "parseSqlTable" — the old pipe-table parser must be ' +
        'DELETED outright (no rename, no fallback) now that the driver consumes --format json.',
    };
  }

  // ── 4.4f: negative — must not reintroduce the optional-chaining-to-silent-empty
  // shape that produces a bogus "0 events captured" report (reviewer finding m-3)
  // instead of failing loud on a malformed/zero-statement envelope.
  if (scriptStripped.includes('?? []') || scriptStripped.includes('?.rows')) {
    return {
      name,
      pass: false,
      detail:
        'scripts/playtest-report.mjs contains "?? []" or "?.rows" — this optional-chaining-to-silent-empty ' +
        'shape swallows a malformed or zero-statement-result envelope into a bogus "0 events captured" report ' +
        'instead of throwing (reviewer finding m-3). decodeSqlJson must fail loud on that shape instead.',
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

  // ── 4.7: query must NOT use ORDER BY (regression guard). SpacetimeDB 2.8.1's
  // SQL dialect rejects it outright (re-verified live 2026-08-22: "Unsupported:
  // ...ORDER BY..." 400 Bad Request) — a query containing it means
  // `just playtest-report` is broken end-to-end again, exactly the failure mode
  // this eval previously could not catch (it string-scanned FOR "ORDER BY
  // event_id", which is the opposite of what's safe).
  if (scriptStripped.includes('ORDER BY') || scriptStripped.includes('order by')) {
    return {
      name,
      pass: false,
      detail:
        'scripts/playtest-report.mjs SQL query text contains "ORDER BY" — SpacetimeDB 2.8.1 ' +
        '(re-verified 2026-08-22) rejects this clause (400 Unsupported), which breaks `just playtest-report` ' +
        'end-to-end. The group[0]="first encounter" ordering (PT-B2-RT-01) must instead be enforced ' +
        'client-side via the exported sortByEventId() applied to the parsed rows before aggregateReport().',
    };
  }

  // ── 4.7b: driver selects event_id (required by sortByEventId) and calls sortByEventId
  // before aggregateReport — the ordering guarantee must actually be wired up, not just exist.
  if (!scriptStripped.includes('event_id')) {
    return {
      name,
      pass: false,
      detail:
        'scripts/playtest-report.mjs does not reference "event_id" anywhere — the SELECT query ' +
        'must fetch it so sortByEventId can order rows by encounter sequence (PT-B2-RT-01).',
    };
  }
  if (!scriptStripped.includes('sortByEventId(')) {
    return {
      name,
      pass: false,
      detail:
        'scripts/playtest-report.mjs does not call sortByEventId(...) — parsed rows must be sorted ' +
        'by event_id before aggregateReport(), or weakenFirstRate\'s "first encounter" group[0] is ' +
        'non-deterministic (PT-B2-RT-01).',
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
      'aggregateReport pure-fn teeth: empty→zeros (no NaN), fixture-B hand-computed rates (successRate=0.5 baitRate=0.5 weakenFirstRate=2/3 recatchRate=1/3), kind=2 filtered, PII-firewall (no hex identity in return);',
      'sortByEventId teeth: out-of-order→ascending, non-mutating, group[0] after sort is the lowest event_id (PT-B2-RT-01, enforced client-side since SpacetimeDB 2.8.1 rejects ORDER BY);',
      'decodeSqlJson teeth: verbatim 4-row --format json capture decoded positionally (unsorted, typed event_id/success, bait_item_id=42 on event 30), valid-empty→[], 12-case must-throw table (non-JSON, empty, non-array top level, zero/multi statement results, missing/empty/unnamed/duplicate schema columns, missing/non-array rows, non-array row, 7-vs-5 arity mismatch), __proto__-column safety;',
      'coerceRow teeth: one-element Identity→bare hex string, two-element Identity throws, missing key throws, non-finite numeric throws, success:"true" string throws, full decodeSqlJson→coerceRow→sortByEventId→aggregateReport round-trip over the 4-row capture reproduces hand-computed rates (successRate=2/3 baitRate=1/3 weakenFirstRate=1 recatchRate=0.5), a reverse-input-order re-run still recovers weakenFirstRate=1 (ordering-sensitive discriminator), and a strictly-between-0-and-1 hand-written fixture (weakenFirstRate=0.5) rules out hard-coded 0/1 returns;',
      'justfile: playtest-report recipe present;',
      'script: exists, non-trivial, exports aggregateReport/sortByEventId/decodeSqlJson/coerceRow, uses execFileSync (no shell-string), passes --format and json as separate array elements, calls JSON.parse(, has no vestigial parseSqlTable, has no "?? []"/"?.rows" silent-empty shape, has process.exit(1), filters kind===1, query has no ORDER BY, selects event_id, calls sortByEventId before aggregateReport.',
    ].join(' '),
  };
}
