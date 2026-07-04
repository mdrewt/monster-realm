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
//   TOOTH B      — drift check flags a stale committed bundle (must bite)
//
// IMPORTANT: NO new RegExp(...) — all patterns use literal regex or String
// methods (detect-non-literal-regexp Semgrep rule has bitten this project 3×).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

    if (!toothAFails.some((f) => f.indexOf('type') !== -1)) {
      return {
        name,
        pass: false,
        detail:
          'TOOTH A: lintFile did not flag a concept missing the required `type` field ' +
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
  } finally {
    rmSync(tmpTeeth, { recursive: true, force: true });
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
    writeFileSync(staleTarget, originalContent + '\n<!-- STALE: source-changed marker -->');

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
    rmSync(tmpBundle, { recursive: true, force: true });
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
  const driftResult = runExport(['docs/knowledge', '--check']);
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

  return {
    name,
    pass: true,
    detail: `${concepts.length} concept(s) lint-clean; drift gate passed (committed bundle matches source)`,
  };
}
