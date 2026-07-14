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
//
// m13.5a additions (EARS 13.5a-4):
//   - shopView.ts added to DOM_SHELLS (M13d shell — was stale; real vite.config.ts
//     already excludes it; findMissingExclusions would otherwise miss regressions on it)
//   - findUnsanctionedExclusions: detects entries in coverage.exclude that are NOT in
//     the sanctioned set (DOM_SHELLS ∪ {src/module_bindings/**} ∪ spread token)
//   - coverageIncludeIsFull: ensures include: ['src/**/*.ts'] is not narrowed
//
// EXPECTED REAL-TREE STATE AT RED (m13.5a): this eval is GREEN once shopView.ts is
// in DOM_SHELLS (the real vite.config.ts already excludes it). Its 13.5a-4 value is
// fixture-proven; the eval was already green for findMissingExclusions; the two new
// predicates also pass on the real config.
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
  // M13d: shop DOM shell (ADR-0084) — added m13.5a; real vite.config.ts already excludes it
  'src/ui/shopView.ts',
  // m15b: trade DOM shell (ADR-0107)
  'src/ui/tradeView.ts',
];

// Sanctioned exclusion entries for findUnsanctionedExclusions.
// Any entry in vite.config.ts coverage.exclude that is NOT in this set is unsanctioned.
const SANCTIONED_EXCLUDES = new Set([...DOM_SHELLS, 'src/module_bindings/**']);
// The spread token that must be present in the exclude array to preserve vitest defaults.
const SPREAD_TOKEN = '...coverageConfigDefaults.exclude';

/**
 * Strip JS/TS line comments (// …) and block comments (/* … *\/) from source,
 * leaving all string contents UNTOUCHED so glob patterns like `src/**\/*.ts`
 * and `src/module_bindings/**` survive stripping intact.
 *
 * The regex approach (`replace(/\/\*[\s\S]*?\*\//g)`) treats the `/*` inside
 * a glob string literal as a block-comment opener and mangles the string — that
 * is why we use a quote-aware single-pass character scanner instead.
 *
 * States: normal | line-comment | block-comment |
 *         in-single-quote | in-double-quote | in-template-literal
 * In string/template states characters pass through untouched (backslash
 * escapes are respected so `\'` inside a single-quoted string does not
 * prematurely close it).
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const len = src.length;
  let state = 'normal'; // 'normal' | 'line' | 'block' | 'sq' | 'dq' | 'tl'

  while (i < len) {
    const ch = src[i];
    const next = i + 1 < len ? src[i + 1] : '';

    if (state === 'normal') {
      if (ch === '/' && next === '/') {
        state = 'line';
        i += 2;
      } else if (ch === '/' && next === '*') {
        state = 'block';
        i += 2;
      } else if (ch === "'") {
        state = 'sq';
        out += ch;
        i++;
      } else if (ch === '"') {
        state = 'dq';
        out += ch;
        i++;
      } else if (ch === '`') {
        state = 'tl';
        out += ch;
        i++;
      } else {
        out += ch;
        i++;
      }
    } else if (state === 'line') {
      if (ch === '\n') {
        out += '\n';
        state = 'normal';
      }
      i++;
    } else if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'normal';
        i += 2;
      } else {
        i++;
      }
    } else if (state === 'sq') {
      out += ch;
      if (ch === '\\' && i + 1 < len) {
        i++;
        out += src[i];
        i++;
      } else if (ch === "'") {
        state = 'normal';
        i++;
      } else {
        i++;
      }
    } else if (state === 'dq') {
      out += ch;
      if (ch === '\\' && i + 1 < len) {
        i++;
        out += src[i];
        i++;
      } else if (ch === '"') {
        state = 'normal';
        i++;
      } else {
        i++;
      }
    } else if (state === 'tl') {
      out += ch;
      if (ch === '\\' && i + 1 < len) {
        i++;
        out += src[i];
        i++;
      } else if (ch === '`') {
        state = 'normal';
        i++;
      } else {
        i++;
      }
    } else {
      out += ch;
      i++;
    }
  }
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

/**
 * Find exclusion entries in vite.config.ts coverage.exclude that are NOT in the
 * sanctioned set (DOM_SHELLS ∪ {src/module_bindings/**} ∪ spread token).
 *
 * Algorithm (comment-stripped):
 *   1. Strip comments.
 *   2. Locate `exclude: [` and scan forward to find the FIRST UNQUOTED `]` — the
 *      array closer. A `]` that appears inside a single-quoted string (e.g. in a
 *      bracketed glob like `'glob[0-9].ts'`) must NOT terminate the scan early.
 *      F7: the old `indexOf(']')` did not respect quoting and would terminate on
 *      any `]` in a glob path, hiding later unsanctioned entries.
 *   3. Check that the spread token is present in the slice.
 *   4. Collect single-quoted string literals from the slice and report unsanctioned ones.
 *
 * Returns an array of unsanctioned entry strings. Empty array = fully sanctioned.
 * The spread token absence is reported as a synthetic unsanctioned entry
 * '(missing spread ...coverageConfigDefaults.exclude)'.
 */
export function findUnsanctionedExclusions(configSrc) {
  const stripped = stripComments(configSrc);
  const unsanctioned = [];

  // Locate the exclude: [ array inside the coverage: object.
  const excludeOpen = stripped.indexOf('exclude: [');
  if (excludeOpen === -1) {
    // No exclude array found — the spread is also absent.
    unsanctioned.push('(missing spread ...coverageConfigDefaults.exclude)');
    return unsanctioned;
  }
  const arrayStart = excludeOpen + 'exclude: ['.length;

  // F7: scan forward from arrayStart to find the first UNQUOTED `]`.
  // A `]` inside a single-quoted string literal does not close the array.
  // We track whether we are inside a single-quoted string and respect `\'` escapes.
  let arrayEnd = -1;
  let inSq = false;
  for (let i = arrayStart; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inSq) {
      if (ch === '\\' && i + 1 < stripped.length) {
        i++; // skip escaped character
      } else if (ch === "'") {
        inSq = false;
      }
    } else {
      if (ch === "'") {
        inSq = true;
      } else if (ch === ']') {
        arrayEnd = i;
        break;
      }
    }
  }

  // Slice the text that is strictly inside the exclude array brackets.
  const excludeSlice =
    arrayEnd !== -1 ? stripped.slice(arrayStart, arrayEnd) : stripped.slice(arrayStart);

  // Require the spread token inside the exclude array slice.
  if (excludeSlice.indexOf(SPREAD_TOKEN) === -1) {
    unsanctioned.push('(missing spread ...coverageConfigDefaults.exclude)');
  }

  // Collect single-quoted string literals from the exclude array slice ONLY.
  // Split on "'" and iterate pairs: every odd-indexed segment sits between quote pairs.
  // This avoids picking up import paths, include entries, or any other quoted
  // strings that live outside the exclude array.
  const parts = excludeSlice.split("'");
  for (let i = 1; i < parts.length; i += 2) {
    const entry = parts[i];
    // Only consider path-like entries (contain '/' or '*').
    if (entry && (entry.indexOf('/') !== -1 || entry.indexOf('*') !== -1)) {
      if (!SANCTIONED_EXCLUDES.has(entry)) {
        unsanctioned.push(entry);
      }
    }
  }

  return unsanctioned;
}

/**
 * Returns true iff the comment-stripped config source contains the full include
 * directive include: ['src/** /*.ts'] (without the space). Include-narrowing
 * (e.g. to 'src/models/**') shrinks the coverage denominator without touching
 * exclude — a coverage bypass the review must catch.
 */
export function coverageIncludeIsFull(configSrc) {
  const stripped = stripComments(configSrc);
  // Accept either single or double quote form, but the canonical form is single-quoted.
  return (
    stripped.indexOf("include: ['src/**/*.ts']") !== -1 ||
    stripped.indexOf('include: ["src/**/*.ts"]') !== -1
  );
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

  // ------------------------------------------------------------------
  // m13.5a PROOF-OF-TEETH: findUnsanctionedExclusions
  //
  // T-unsanctioned-bad: config with src/battle/battleModel.ts in exclude
  //   → flagged as unsanctioned.
  //   Kills: impl that doesn't check against the sanctioned set.
  // ------------------------------------------------------------------
  const unsanctionedBadConfig = `
    import { coverageConfigDefaults } from 'vitest/config';
    coverage: {
      include: ['src/**/*.ts'],
      exclude: [
        ...coverageConfigDefaults.exclude,
        'src/module_bindings/**',
        'src/main.ts',
        'src/net/connection.ts',
        'src/render/world.ts',
        'src/render/characterView.ts',
        'src/render/placeholderAssets.ts',
        'src/ui/battleView.ts',
        'src/ui/boxView.ts',
        'src/ui/raisingView.ts',
        'src/ui/evolutionView.ts',
        'src/ui/dialogueView.ts',
        'src/ui/questLogView.ts',
        'src/ui/healView.ts',
        'src/ui/shopView.ts',
        'src/battle/battleModel.ts',
      ],
    },
  `;
  {
    const got = findUnsanctionedExclusions(unsanctionedBadConfig);
    if (!got.includes('src/battle/battleModel.ts')) {
      return {
        name,
        pass: false,
        detail:
          'T-unsanctioned-bad: findUnsanctionedExclusions did not flag src/battle/battleModel.ts as unsanctioned — kills impl that does not check the sanctioned set',
      };
    }
  }

  // T-unsanctioned-good: exact sanctioned set + spread → zero unsanctioned.
  //   Kills: impl that false-flags sanctioned entries.
  const sanctionedGoodConfig = [
    "import { coverageConfigDefaults } from 'vitest/config';",
    'coverage: {',
    "  include: ['src/**/*.ts'],",
    '  exclude: [',
    '    ...coverageConfigDefaults.exclude,',
    "    'src/module_bindings/**',",
    ...DOM_SHELLS.map((s) => `    '${s}',`),
    '  ],',
    '},',
  ].join('\n');
  {
    const got = findUnsanctionedExclusions(sanctionedGoodConfig);
    if (got.length > 0) {
      return {
        name,
        pass: false,
        detail: `T-unsanctioned-good: findUnsanctionedExclusions wrongly flagged entries in a fully-sanctioned config: ${got.join(', ')}`,
      };
    }
  }

  // T-unsanctioned-no-spread: config without the spread token → flagged.
  //   Kills: impl that doesn't require the spread (vitest defaults would be silently dropped).
  const noSpreadConfig = [
    'coverage: {',
    "  include: ['src/**/*.ts'],",
    '  exclude: [',
    "    'src/module_bindings/**',",
    ...DOM_SHELLS.map((s) => `    '${s}',`),
    '  ],',
    '},',
  ].join('\n');
  {
    const got = findUnsanctionedExclusions(noSpreadConfig);
    if (!got.includes('(missing spread ...coverageConfigDefaults.exclude)')) {
      return {
        name,
        pass: false,
        detail:
          'T-unsanctioned-no-spread: findUnsanctionedExclusions did not flag a missing spread token — the spread must be required so vitest defaults are never silently dropped',
      };
    }
  }

  // T-unsanctioned-comment-only: unsanctioned path in a comment must NOT be flagged.
  //   Kills: impl that collects from raw (non-stripped) source.
  const commentOnlyUnsanctionedConfig = [
    "import { coverageConfigDefaults } from 'vitest/config';",
    'coverage: {',
    "  include: ['src/**/*.ts'],",
    '  exclude: [',
    '    // src/battle/battleModel.ts  <- unsanctioned but only in a comment',
    '    ...coverageConfigDefaults.exclude,',
    "    'src/module_bindings/**',",
    ...DOM_SHELLS.map((s) => `    '${s}',`),
    '  ],',
    '},',
  ].join('\n');
  {
    const got = findUnsanctionedExclusions(commentOnlyUnsanctionedConfig);
    if (got.includes('src/battle/battleModel.ts')) {
      return {
        name,
        pass: false,
        detail:
          'T-unsanctioned-comment-only: findUnsanctionedExclusions flagged a path that only appears in a comment — must strip comments before scanning',
      };
    }
  }

  // ------------------------------------------------------------------
  // m13.5a PROOF-OF-TEETH: F7 — findUnsanctionedExclusions bracket-aware array bounding
  //
  // T-F7-bracket-glob: exclude array has a glob with `[0-9]` BEFORE an unsanctioned
  // entry. The `]` inside the bracketed glob must NOT terminate the array scan.
  // An impl using `indexOf(']', arrayStart)` would find the `]` from `[0-9]` and
  // stop there, hiding the later unsanctioned entry.
  //
  // Kills: impl that uses raw `indexOf(']')` without quote-aware scanning.
  // ------------------------------------------------------------------
  const bracketGlobUnsanctionedConfig = [
    "import { coverageConfigDefaults } from 'vitest/config';",
    'coverage: {',
    "  include: ['src/**/*.ts'],",
    '  exclude: [',
    '    ...coverageConfigDefaults.exclude,',
    "    'src/module_bindings/**',",
    "    'src/test[0-9]/helper.ts',", // bracket glob: `]` must NOT close the array scan
    ...DOM_SHELLS.map((s) => `    '${s}',`),
    "    'src/battle/battleModel.ts',", // unsanctioned — must still be found
    '  ],',
    '},',
  ].join('\n');
  {
    const got = findUnsanctionedExclusions(bracketGlobUnsanctionedConfig);
    if (!got.includes('src/battle/battleModel.ts')) {
      return {
        name,
        pass: false,
        detail:
          "T-F7-bracket-glob: findUnsanctionedExclusions did not flag 'src/battle/battleModel.ts' when it appears AFTER a bracketed glob ('src/test[0-9]/helper.ts') in the exclude array — the `]` in the glob must not terminate the array scan; use quote-aware scanning",
      };
    }
  }
  // Positive control: the bracket-glob entry itself ('src/test[0-9]/helper.ts') is
  // unsanctioned and must also be reported (it is not in DOM_SHELLS).
  {
    const got = findUnsanctionedExclusions(bracketGlobUnsanctionedConfig);
    if (!got.includes('src/test[0-9]/helper.ts')) {
      return {
        name,
        pass: false,
        detail:
          "T-F7-bracket-glob-entry: findUnsanctionedExclusions should also flag 'src/test[0-9]/helper.ts' itself as unsanctioned (it is not in DOM_SHELLS)",
      };
    }
  }
  // Sanctioned-good-after-bracket-glob: replace the unsanctioned entry with nothing
  // (just the bracket-glob + all DOM_SHELLS + spread) — must return zero unsanctioned.
  const bracketGlobSanctionedConfig = [
    "import { coverageConfigDefaults } from 'vitest/config';",
    'coverage: {',
    "  include: ['src/**/*.ts'],",
    '  exclude: [',
    '    ...coverageConfigDefaults.exclude,',
    "    'src/module_bindings/**',",
    ...DOM_SHELLS.map((s) => `    '${s}',`),
    '  ],',
    '},',
  ].join('\n');
  {
    const got = findUnsanctionedExclusions(bracketGlobSanctionedConfig);
    if (got.length > 0) {
      return {
        name,
        pass: false,
        detail: `T-F7-bracket-glob-good: findUnsanctionedExclusions wrongly flagged entries in the fully-sanctioned config (no bracket glob in the actual real config): ${got.join(', ')}`,
      };
    }
  }

  // ------------------------------------------------------------------
  // m13.5a PROOF-OF-TEETH: coverageIncludeIsFull
  //
  // T-include-narrowed: include narrowed to src/models/**/.ts → false.
  //   Kills: impl that doesn't check the exact include glob.
  // ------------------------------------------------------------------
  const narrowIncludeConfig = `
    coverage: {
      include: ['src/models/**/*.ts'],
      exclude: [...coverageConfigDefaults.exclude],
    },
  `;
  if (coverageIncludeIsFull(narrowIncludeConfig)) {
    return {
      name,
      pass: false,
      detail:
        "T-include-narrowed: coverageIncludeIsFull accepted a narrowed include: ['src/models/**/*.ts'] — must require exactly src/**/*.ts",
    };
  }

  // T-include-full: include: ['src/**/*.ts'] → true.
  const fullIncludeConfig = `
    coverage: {
      include: ['src/**/*.ts'],
      exclude: [...coverageConfigDefaults.exclude],
    },
  `;
  if (!coverageIncludeIsFull(fullIncludeConfig)) {
    return {
      name,
      pass: false,
      detail:
        "T-include-full: coverageIncludeIsFull rejected the correct include: ['src/**/*.ts'] (false negative)",
    };
  }

  // ------------------------------------------------------------------
  // m13.5a REAL FILE CHECKS: findUnsanctionedExclusions + coverageIncludeIsFull
  // EXPECTED REAL-TREE STATE: GREEN (real vite.config.ts is already fully sanctioned
  // and has include: ['src/**/*.ts']).
  // ------------------------------------------------------------------
  const unsanctioned = findUnsanctionedExclusions(src);
  if (unsanctioned.length > 0) {
    return {
      name,
      pass: false,
      detail: `coverage.exclude in vite.config.ts contains unsanctioned entries: ${unsanctioned.join(', ')} — only DOM_SHELLS, src/module_bindings/**, and the coverageConfigDefaults.exclude spread are sanctioned`,
    };
  }

  if (!coverageIncludeIsFull(src)) {
    return {
      name,
      pass: false,
      detail:
        "vite.config.ts coverage.include is not exactly ['src/**/*.ts'] — narrowing the include shrinks the coverage denominator without touching exclude (a coverage bypass)",
    };
  }

  return {
    name,
    pass: true,
    detail: `All ${DOM_SHELLS.length} DOM-shell paths are in coverage.exclude (T1/T2/T3 teeth all pass; comment-stripping active); m13.5a: shopView.ts in DOM_SHELLS, m15b: tradeView.ts in DOM_SHELLS, zero unsanctioned exclusions, include: ['src/**/*.ts'] full`,
  };
}
