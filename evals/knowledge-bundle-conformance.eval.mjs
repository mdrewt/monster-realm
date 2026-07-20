// knowledge-bundle-conformance.eval.mjs — OKF bundle lint + drift gate (M8.95b).
//
// Verifies that:
//   1. Every concept in docs/knowledge/ conforms to the OKF contract (required
//      frontmatter, slug==path, type∈vocab, abstract≤120, links resolve).
//   2. The committed bundle matches what scripts/okf-export.mjs would generate
//      (drift gate — any hand-edit fails CI per ADR-0050 / SSOT rule).
//
// Proof-of-teeth (ADR-0010):
//   TOOTH A      — lint rejects a concept missing `type` (must bite)
//   TOOTH A-good — lint accepts a well-formed concept (false-positive guard)
//   TOOTH C      — lint rejects a concept with a dangling bundle-relative link (must bite)
//   TOOTH B      — drift check flags a stale committed bundle (must bite)
//
// IMPORTANT: NO new RegExp(...) — all patterns use literal regex or String
// methods (detect-non-literal-regexp Semgrep rule has bitten this project 3×).

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BUNDLE_DIR = path.join(ROOT, 'docs', 'knowledge');
const LINT_PATH = path.join(ROOT, '.claude', 'hooks', 'okf-lint.mjs');
const EXPORT_PATH = path.join(ROOT, 'scripts', 'okf-export.mjs');

// Import the vendored linter (no cross-repo path — vendor pattern, ADR-0057 §risks).
const { lintFile, collectConcepts } = await import(LINT_PATH);

// ---------------------------------------------------------------------------
// ptc5d-2: Pure predicate — no concept page under reducers/ or tables/ may have
// a `resource:` or `source:` frontmatter line that references a `*_tests.rs`
// file (ADR-0137 D2).
//
// Matching discipline (ADR-0010 anti-patterns D2):
//   - Only inspect lines whose trimStart() starts with "resource:" or "source:"
//     (avoids false-positive on an abstract/body that mentions a test file, or on
//     a tags: line like `tags: [..., ranking_tests]` which has no `.rs` suffix).
//   - Require the substring `_tests.rs` (with the `.rs` suffix) so the above
//     `ranking_tests` tag does NOT match.
//   - Walk both reducers/ and tables/ subdirs (symmetric — catches a future
//     test-file #[spacetimedb::table] fixture too).
//
// Returns an array of "relpath: <line>" strings for every offending line found.
// Empty array = clean.
//
// NO new RegExp() — all matching uses String methods (detect-non-literal-regexp safe).
// ---------------------------------------------------------------------------
export function findTestSourcedPages(bundleDir) {
  const offenders = [];
  const subdirs = ['reducers', 'tables'];
  for (const sub of subdirs) {
    const subDir = path.join(bundleDir, sub);
    if (!existsSync(subDir) || !statSync(subDir).isDirectory()) continue;
    for (const entry of readdirSync(subDir).sort()) {
      if (!entry.endsWith('.md')) continue;
      const full = path.join(subDir, entry);
      let txt;
      try {
        txt = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      // Only scan frontmatter: lines between first --- and second ---.
      const afterOpen = txt.startsWith('---') ? txt.slice(3) : null;
      if (!afterOpen) continue;
      const bodyStart = afterOpen.indexOf('\n');
      if (bodyStart === -1) continue;
      const afterFirstLine = afterOpen.slice(bodyStart + 1);
      const fmEnd = afterFirstLine.indexOf('\n---');
      const fmBlock = fmEnd !== -1 ? afterFirstLine.slice(0, fmEnd) : afterFirstLine;
      const relpath = path.join(sub, entry).replace(/\\/g, '/');
      for (const line of fmBlock.split('\n')) {
        const trimmed = line.trimStart();
        const isResourceOrSource = trimmed.startsWith('resource:') || trimmed.startsWith('source:');
        if (!isResourceOrSource) continue;
        if (trimmed.indexOf('_tests.rs') !== -1) {
          offenders.push(`${relpath}: ${line}`);
        }
      }
    }
  }
  return offenders;
}

// ---------------------------------------------------------------------------
// Helper: run okf-export.mjs; return { code, stderr }.
// spawnSync is used (not execFileSync) so we can capture a non-zero exit without
// throwing — we need exit codes as data, not as exceptions.
// ---------------------------------------------------------------------------
function runExport(args) {
  const result = spawnSync('node', [EXPORT_PATH, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return {
    code: result.status !== null ? result.status : 1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
}

// ---------------------------------------------------------------------------
// Default export — proof-of-teeth, then real file checks.
// ---------------------------------------------------------------------------
export default async function () {
  const name = 'knowledge-bundle-conformance (M8.95b: OKF lint + drift gate for docs/knowledge/)';

  // =========================================================================
  // PROOF-OF-TEETH — inline fixtures; eval FAILs if any tooth has no bite
  // =========================================================================

  // TOOTH A — a concept with a missing `type` field must be rejected by lint.
  // Uses a fresh temp dir so lintFile's slug-vs-path check sees a consistent root.
  const tmpTeeth = mkdtempSync(path.join(tmpdir(), 'okf-teeth-'));
  try {
    const missingTypeContent = [
      '---',
      'title: Bad Concept',
      'slug: bad-concept',
      'updated: 2026-01-01',
      'tags: [test]',
      'abstract: "A concept that is deliberately missing the required type field."',
      '---',
      '',
      '## Body',
      '',
      'This concept has no type field and must fail conformance lint.',
    ].join('\n');

    const badFile = path.join(tmpTeeth, 'bad-concept.md');
    writeFileSync(badFile, missingTypeContent);
    const { fails: toothAFails } = lintFile(badFile, tmpTeeth);

    // Exact-match the error message produced by Rule 1 for a missing required key.
    // indexOf('type') is NOT sufficient — a dangling link to ./nonexistent-type-foo.md
    // also produces a fail containing 'type', making the tooth gameable: a broken
    // type-missing rule could be masked by adding such a link to the fixture.
    if (!toothAFails.includes('missing required frontmatter key: type')) {
      return {
        name,
        pass: false,
        detail:
          'TOOTH A: lintFile did not produce the exact failure "missing required frontmatter ' +
          'key: type" for a concept missing the required `type` field ' +
          '(false negative — the lint predicate has no bite; a malformed concept would slip through)',
      };
    }

    // TOOTH A-good — a well-formed concept must NOT be rejected (false-positive guard).
    const wellFormedContent = [
      '---',
      'type: SpacetimeDB Table',
      'title: test-concept',
      'slug: test-concept',
      'updated: 2026-01-01',
      'tags: [schema, spacetimedb, public]',
      'abstract: "A well-formed concept written as a positive control for the lint tooth."',
      'resource: server-module/src/schema.rs#L1',
      'source: scripts/okf-export.mjs@server-module/src/schema.rs',
      'visibility: public',
      '---',
      '',
      '## Body',
      '',
      'Well-formed concept — no lint failures expected.',
    ].join('\n');

    const goodFile = path.join(tmpTeeth, 'test-concept.md');
    writeFileSync(goodFile, wellFormedContent);
    const { fails: toothAGoodFails } = lintFile(goodFile, tmpTeeth);

    if (toothAGoodFails.length > 0) {
      return {
        name,
        pass: false,
        detail:
          'TOOTH A-good: lintFile rejected a well-formed concept that should pass ' +
          `(false positive — lint is too strict): ${toothAGoodFails.join('; ')}`,
      };
    }

    // TOOTH C — a concept with a dangling bundle-relative link must be rejected (Rule 5).
    // Tests link-resolution separately from the required-key check (TOOTH A tests Rule 1;
    // TOOTH C tests Rule 5 — both must have independent bite).
    const danglingContent = [
      '---',
      'type: SpacetimeDB Table',
      'title: link-test',
      'slug: link-test',
      'updated: 2026-01-01',
      'tags: [schema, spacetimedb, public]',
      'abstract: "A concept with a dangling bundle-relative link for testing Rule 5."',
      '---',
      '',
      '## See Also',
      '',
      '[see other](nonexistent-table.md)',
    ].join('\n');

    const linkFile = path.join(tmpTeeth, 'link-test.md');
    writeFileSync(linkFile, danglingContent);
    const { fails: toothCFails } = lintFile(linkFile, tmpTeeth);

    if (!toothCFails.some((f) => f.indexOf('dangling bundle-relative link') !== -1)) {
      return {
        name,
        pass: false,
        detail:
          'TOOTH C: lintFile did not flag a concept with a dangling bundle-relative link ' +
          '(false negative — Rule 5 link-resolution check has no bite; a broken link in ' +
          'the bundle would go undetected)',
      };
    }
  } finally {
    try {
      rmSync(tmpTeeth, { recursive: true, force: true });
    } catch (e) {
      console.warn(`okf-eval: tmpTeeth cleanup warn: ${e.message}`);
    }
  }

  // =========================================================================
  // ptc5d-2 PROOF-OF-TEETH — findTestSourcedPages predicate (ADR-0137 D2)
  //
  // Uses synthetic temp-dir fixtures only — does NOT call runExport().
  // Calling runExport() after the D1 fix is applied would run the corrected
  // generator and self-defeat the bad-fixture (the fixed generator would write
  // a clean page, so the predicate would return empty even on the bad content).
  // The predicate is a pure function over file content — the fixture is the oracle.
  // =========================================================================
  const tmpTeethD2 = mkdtempSync(path.join(tmpdir(), 'okf-teeth-d2-'));
  try {
    // Create reducers/ subdir (the predicate only walks reducers/ and tables/).
    const reducersDir = path.join(tmpTeethD2, 'reducers');
    mkdirSync(reducersDir, { recursive: true });

    // TOOTH D2-bad — a concept page with source: / resource: pointing at a
    // *_tests.rs file must be flagged by findTestSourcedPages.
    // Kills: impl that doesn't scan source:/resource: lines, or that uses a
    // blob indexOf without line-prefix discipline (would miss lines, or could
    // match the tags line `ranking_tests` — but the `.rs` suffix guard prevents
    // that false-positive for the tags case).
    const badPageContent = [
      '---',
      'type: SpacetimeDB Reducer',
      'title: set_profile_name',
      'slug: reducers/set_profile_name',
      'updated: 2026-07-19',
      'tags: [reducer, spacetimedb, ranking_tests]',
      'abstract: "SpacetimeDB reducer set_profile_name."',
      'resource: server-module/src/ranking_tests.rs#L1396',
      'source: scripts/okf-export.mjs@server-module/src/ranking_tests.rs',
      '---',
      '',
      '## Signature',
      '',
      '```rust',
      'pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String>',
      '```',
    ].join('\n');
    writeFileSync(path.join(reducersDir, 'set_profile_name.md'), badPageContent);

    const d2BadResult = findTestSourcedPages(tmpTeethD2);
    if (d2BadResult.length === 0) {
      return {
        name,
        pass: false,
        detail:
          'TOOTH D2-bad: findTestSourcedPages returned empty for a concept page with ' +
          'source:/resource: lines pointing at ranking_tests.rs — predicate has no bite ' +
          '(kills impl that skips source:/resource: lines, or that requires the `.rs` suffix ' +
          'but fails to match the combined `_tests.rs` token)',
      };
    }

    // TOOTH D2-good — a concept page with source: / resource: pointing at the
    // REAL (non-test) file must NOT be flagged (false-positive guard).
    // Kills: impl with an overly broad match (e.g. indexOf('_tests') without .rs
    // suffix, or a blob scan that hits the tags: line `ranking_tests`).
    const goodPageContent = [
      '---',
      'type: SpacetimeDB Reducer',
      'title: set_profile_name',
      'slug: reducers/set_profile_name',
      'updated: 2026-07-19',
      'tags: [reducer, spacetimedb, ranking_tests]',
      'abstract: "SpacetimeDB reducer set_profile_name."',
      'resource: server-module/src/ranking.rs#L139',
      'source: scripts/okf-export.mjs@server-module/src/ranking.rs',
      '---',
      '',
      '## Signature',
      '',
      '```rust',
      'pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String>',
      '```',
    ].join('\n');
    // Overwrite the bad fixture with the good one.
    writeFileSync(path.join(reducersDir, 'set_profile_name.md'), goodPageContent);

    const d2GoodResult = findTestSourcedPages(tmpTeethD2);
    if (d2GoodResult.length > 0) {
      return {
        name,
        pass: false,
        detail:
          'TOOTH D2-good: findTestSourcedPages flagged a concept page whose source:/resource: ' +
          'lines point at ranking.rs (the real non-test file) — false positive. ' +
          `Offenders: ${d2GoodResult.join('; ')}. ` +
          'Check that the predicate requires the `_tests.rs` suffix (not just `_tests`) ' +
          'and does not accidentally match the tags: line containing `ranking_tests`.',
      };
    }
  } finally {
    try {
      rmSync(tmpTeethD2, { recursive: true, force: true });
    } catch (e) {
      console.warn(`okf-eval: tmpTeethD2 cleanup warn: ${e.message}`);
    }
  }

  // TOOTH B — the drift check must detect a stale committed concept.
  // Procedure: generate a correct bundle to a temp dir, modify one file to be
  // stale, then run --check against the temp dir and expect exit 1.
  const tmpBundle = mkdtempSync(path.join(tmpdir(), 'okf-stale-'));
  try {
    // Step 1: generate a correct bundle into tmpBundle (write mode, no --check).
    const genResult = runExport([tmpBundle]);
    if (genResult.code !== 0) {
      return {
        name,
        pass: false,
        detail:
          `TOOTH B: okf-export.mjs failed to generate a fresh bundle to a temp dir ` +
          `(exit ${genResult.code}) — cannot execute the stale-bundle tooth: ${genResult.stderr.slice(0, 300)}`,
      };
    }

    // Step 2: make schema-overview.md stale by appending a marker comment.
    const staleTarget = path.join(tmpBundle, 'schema-overview.md');
    if (!existsSync(staleTarget)) {
      return {
        name,
        pass: false,
        detail:
          'TOOTH B: schema-overview.md absent from freshly generated temp bundle — ' +
          'unexpected generator output; cannot execute the stale-bundle tooth',
      };
    }
    const originalContent = readFileSync(staleTarget, 'utf8');
    writeFileSync(staleTarget, `${originalContent}\n<!-- STALE: source-changed marker -->`);

    // Step 3: --check must detect the stale file → exit non-zero.
    const checkResult = runExport([tmpBundle, '--check']);
    if (checkResult.code === 0) {
      return {
        name,
        pass: false,
        detail:
          'TOOTH B: drift check exited 0 on a bundle with a stale concept ' +
          '(false negative — the drift gate has no bite; a hand-edit to a generated file would go undetected)',
      };
    }
  } finally {
    try {
      rmSync(tmpBundle, { recursive: true, force: true });
    } catch (e) {
      console.warn(`okf-eval: tmpBundle cleanup warn: ${e.message}`);
    }
  }

  // =========================================================================
  // REAL FILE CHECKS
  // =========================================================================

  // Check 1 — bundle directory exists (generated by just knowledge / M8.95a).
  if (!existsSync(BUNDLE_DIR)) {
    return {
      name,
      pass: false,
      detail:
        'docs/knowledge/ does not exist — the OKF bundle has not been generated; run `just knowledge`',
    };
  }

  // Check 2 — lint every concept file in docs/knowledge/.
  const concepts = collectConcepts(BUNDLE_DIR);
  if (concepts.length === 0) {
    return {
      name,
      pass: false,
      detail:
        'docs/knowledge/ has no concept files (collectConcepts returned empty) — ' +
        'bundle appears ungenerated or structure is wrong',
    };
  }

  const lintFailures = [];
  for (const conceptFile of concepts) {
    const { fails } = lintFile(conceptFile, BUNDLE_DIR);
    for (const f of fails) {
      const rel = path.relative(BUNDLE_DIR, conceptFile).replace(/\\/g, '/');
      lintFailures.push(`${rel}: ${f}`);
    }
  }

  if (lintFailures.length > 0) {
    const shown = lintFailures.slice(0, 5);
    const extra = lintFailures.length > 5 ? `\n… and ${lintFailures.length - 5} more` : '';
    return {
      name,
      pass: false,
      detail: `Lint: ${lintFailures.length} failure(s) in docs/knowledge/:\n${shown.join('\n')}${extra}`,
    };
  }

  // Check 3 — drift gate: committed bundle must match freshly generated output.
  // Equivalent to `just knowledge-check` (node scripts/okf-export.mjs docs/knowledge --check).
  // Use the absolute BUNDLE_DIR constant (not a relative path) for robustness against
  // any future change to the cwd passed to runExport.
  const driftResult = runExport([BUNDLE_DIR, '--check']);
  if (driftResult.code !== 0) {
    return {
      name,
      pass: false,
      detail:
        'Drift gate: committed docs/knowledge/ differs from what scripts/okf-export.mjs generates — ' +
        'run `just knowledge` to regenerate, then commit the updated bundle.\n' +
        driftResult.stderr.slice(0, 500),
    };
  }

  // Check 4 — ptc5d-2 real-file check: no committed concept page under
  // docs/knowledge/reducers/ or docs/knowledge/tables/ may have a `resource:` or
  // `source:` frontmatter line that points at a `*_tests.rs` file (ADR-0137 D2).
  //
  // RED right now: docs/knowledge/reducers/set_profile_name.md has
  //   resource: server-module/src/ranking_tests.rs#L1396
  //   source: scripts/okf-export.mjs@server-module/src/ranking_tests.rs
  // and docs/knowledge/reducers/playtest_reaper.md has
  //   resource: server-module/src/playtest_tests.rs#L957
  //   source: scripts/okf-export.mjs@server-module/src/playtest_tests.rs
  // GREEN after: implementer adds `_tests.rs` exclusion to collectRsFiles in
  // scripts/okf-export.mjs (ptc5d-1) and regenerates via `just knowledge`.
  const testSourcedOffenders = findTestSourcedPages(BUNDLE_DIR);
  if (testSourcedOffenders.length > 0) {
    const shown = testSourcedOffenders.slice(0, 6);
    const extra =
      testSourcedOffenders.length > 6 ? `\n… and ${testSourcedOffenders.length - 6} more` : '';
    return {
      name,
      pass: false,
      detail:
        'Check 4 (ptc5d-2): committed bundle has concept page(s) whose resource:/source: ' +
        'frontmatter points at *_tests.rs files — these are test fixtures, not real reducers/tables. ' +
        'Fix: add `_tests.rs` exclusion to collectRsFiles in scripts/okf-export.mjs (ADR-0137 D1) ' +
        'then run `just knowledge` to regenerate.\n' +
        shown.join('\n') +
        extra,
    };
  }

  return {
    name,
    pass: true,
    detail:
      `${concepts.length} concept(s) lint-clean; drift gate passed (committed bundle matches source); ` +
      'no test-sourced pages in reducers/ or tables/ (ptc5d-2)',
  };
}
