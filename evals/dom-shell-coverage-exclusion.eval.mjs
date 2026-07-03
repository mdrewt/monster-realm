// Eval: all DOM-shell view files must appear in vite.config.ts coverage.exclude.
//
// Invariant: coverage measurements must exclude hand-wired DOM shells (no unit-testable
// logic; validated by Playwright e2e, not vitest). Adding a new shell file without
// adding it to the exclude list silently pollutes coverage metrics with 0%-covered
// lines and breaks the "covered code = unit-testable logic" ADR-0009/0010 discipline.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M10c (Client evolution/fuse UI).
// Each new *View.ts DOM shell must be added to coverage.exclude in vite.config.ts.
//
// Proof-of-teeth: a config WITHOUT evolutionView.ts in exclude MUST fail; one
// WITH it MUST pass.
import { readFileSync } from 'node:fs';

const DOM_SHELLS = [
  'src/main.ts',
  'src/net/connection.ts',
  'src/render/world.ts',
  'src/render/characterView.ts',
  'src/render/placeholderAssets.ts',
  'src/ui/battleView.ts',
  'src/ui/boxView.ts',
  'src/ui/raisingView.ts',
  'src/ui/evolutionView.ts',
  // M12d: dialogue/quest/heal DOM shells (ADR-0071)
  'src/ui/dialogueView.ts',
  'src/ui/questLogView.ts',
  'src/ui/healView.ts',
];

/**
 * Strip JS/TS line comments (// …) and block comments (/* … *\/) from source.
 * Prevents a shell path mentioned only in a comment from silently satisfying
 * the include-check (12.5f-3).
 */
export function stripComments(src) {
  // Strip block comments first (/* … */), then line comments (// …).
  // Non-greedy block match keeps adjacent blocks distinct.
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/\/\/[^\n]*/g, '');
  return out;
}

/**
 * Check that all known DOM-shell paths appear in the coverage exclude list string
 * (comments stripped — a path appearing ONLY in a comment must NOT satisfy the gate).
 * Returns an array of shell paths that are MISSING from the config.
 */
export function findMissingExclusions(configSrc, shells) {
  const stripped = stripComments(configSrc);
  return shells.filter((shell) => !stripped.includes(shell));
}

export default async function () {
  const name =
    'dom-shell-coverage-exclusion (all *View.ts shells in vite.config.ts coverage.exclude)';

  // ------------------------------------------------------------------
  // Proof-of-teeth T1: a config WITHOUT evolutionView.ts MUST fail.
  // ------------------------------------------------------------------
  const missingEvolutionConfig = `
    coverage: {
      exclude: [
        'src/ui/battleView.ts',
        'src/ui/boxView.ts',
        'src/ui/raisingView.ts',
        // evolutionView.ts intentionally absent
      ],
    },
  `;
  const missingFromBad = findMissingExclusions(missingEvolutionConfig, DOM_SHELLS);
  if (!missingFromBad.includes('src/ui/evolutionView.ts')) {
    return {
      name,
      pass: false,
      detail: 'TEETH T1: findMissingExclusions failed to detect missing evolutionView.ts',
    };
  }

  // ------------------------------------------------------------------
  // Proof-of-teeth T3 (12.5f-3): a path appearing ONLY in a comment
  // must NOT satisfy the check — kills an impl that searches raw text
  // including comments.
  //
  // Fixture: healView.ts appears only in a TS line comment, NOT in the
  // exclude array. An impl that searches raw text would false-pass.
  // ------------------------------------------------------------------
  const commentOnlyConfig = `
    coverage: {
      exclude: [
        // src/ui/healView.ts  ← mentioned in a comment only, NOT in the array
        'src/ui/battleView.ts',
        'src/ui/boxView.ts',
      ],
    },
  `;
  const commentOnlyMissing = findMissingExclusions(commentOnlyConfig, ['src/ui/healView.ts']);
  if (!commentOnlyMissing.includes('src/ui/healView.ts')) {
    return {
      name,
      pass: false,
      detail:
        'TEETH T3 (12.5f-3 comment-strip): healView.ts appears ONLY in a comment but findMissingExclusions reports it as present — impl must strip comments before searching. Kills: an impl that searches raw configSrc.includes() without stripping TS comments first.',
    };
  }

  // ------------------------------------------------------------------
  // Proof-of-teeth: a config WITH all shells MUST pass (no false positive).
  // ------------------------------------------------------------------
  const completeConfig = DOM_SHELLS.map((s) => `'${s}'`).join('\n        ');
  const missingFromGood = findMissingExclusions(completeConfig, DOM_SHELLS);
  if (missingFromGood.length > 0) {
    return {
      name,
      pass: false,
      detail: `TEETH: false positive — found missing shells in complete fixture: ${missingFromGood.join(', ')}`,
    };
  }

  // ------------------------------------------------------------------
  // Real check: read actual vite.config.ts.
  // ------------------------------------------------------------------
  let src;
  try {
    src = readFileSync('client/vite.config.ts', 'utf8');
  } catch (e) {
    return { name, pass: false, detail: `Could not read client/vite.config.ts: ${e.message}` };
  }

  const missing = findMissingExclusions(src, DOM_SHELLS);
  if (missing.length > 0) {
    return {
      name,
      pass: false,
      detail: `DOM shells missing from coverage.exclude in vite.config.ts: ${missing.join(', ')} — add them so coverage metrics reflect unit-testable logic only`,
    };
  }

  return {
    name,
    pass: true,
    detail: `All ${DOM_SHELLS.length} DOM-shell paths are in coverage.exclude (T1/T2/T3 teeth all pass; comment-stripping active)`,
  };
}
