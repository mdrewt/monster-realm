// ci-gate-wiring.eval.mjs — EARS 13.5a-1 + 13.5a-5 gate-of-gates eval.
//
// Verifies that every required `just <verb>` step in the `ci:` job is present,
// unneutered (no step/job-level if:/continue-on-error:), and that the justfile
// `ci:` recipe deps match the ci.yml steps — so gutting either side trips the
// gate without touching the other.
//
// IMPORTANT: NO new RegExp(...) anywhere — use only literal regex literals or
// String methods (detect-non-literal-regexp Semgrep rule has bitten this project 3×).
//
// Proof-of-teeth runs FIRST (known-bad + known-good inline YAML fixtures), then
// real-file checks. Returns { name, pass, detail }.
//
// EXPECTED REAL-TREE STATE AT RED: every real-file check passes EXCEPT
// `anchorIsWired` (lefthook.yml does not yet contain `node evals/ci-gate-wiring.eval.mjs`
// and the e2e job does not yet have `- run: node evals/ci-gate-wiring.eval.mjs`).
// GREEN edit for the implementer:
//   1. Add `node evals/ci-gate-wiring.eval.mjs` under a lefthook.yml pre-push command.
//   2. Add `- run: node evals/ci-gate-wiring.eval.mjs` inside the `e2e:` job in ci.yml.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractJobBlock } from './e2e-desync-teeth.eval.mjs';

// ---------------------------------------------------------------------------
// Hardcoded oracle: these verbs MUST appear as exact `- run: just <verb>` steps
// in the `ci:` job. Hardcoded so that simultaneously removing a dep from the
// justfile AND its ci.yml step still trips this gate.
// ---------------------------------------------------------------------------
export const REQUIRED_JUST_STEPS = [
  'lint',
  'typecheck',
  'test',
  'eval',
  'wasm',
  'client-typecheck',
  'client-test',
];

// Truthy continue-on-error forms (mirrors e2eGateIsBlocking from e2e-desync-teeth).
function isTruthyCoe(value) {
  return /^(true|yes|on|True)\b/.test(value) || /\$\{\{\s*true\s*\}\}/.test(value);
}

// Find the line range of a step that contains `runLine` (exact trimmed match).
// Returns [startIdx, endIdx] (exclusive) within the lines array, or null if not found.
// A step begins at a line whose trimmed form starts with `- ` at 6-space indent.
//
// LATENT ASSUMPTION: the walk-back to find the step's opening `- ` line relies on
// all steps in the job using the 6-space `      - ` prefix (standard GitHub Actions
// YAML indent: jobs at 2-space, job keys at 4-space, step items at 6-space). This
// holds for all real ci.yml steps and all inline fixtures in this file.
function findStepRange(lines, runLine) {
  const STEP_PREFIX = '      - '; // 6-space indent step item
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart() === runLine.trimStart()) {
      // Walk back to find the opening `- ` of this step.
      let stepStart = i;
      while (stepStart > 0 && !lines[stepStart].startsWith(STEP_PREFIX)) {
        stepStart--;
      }
      // Walk forward to find the next `- ` step at the same indent, or block end.
      let stepEnd = i + 1;
      while (stepEnd < lines.length) {
        const ln = lines[stepEnd];
        // A blank line between steps is fine — keep walking.
        if (ln.trim() === '') {
          stepEnd++;
          continue;
        }
        const indent = ln.length - ln.trimStart().length;
        // Another step at 6-space indent, or a job-level key at ≤4-space, ends this step.
        if (indent <= 6 && ln.trimStart().startsWith('- ')) break;
        if (indent <= 4 && !ln.trimStart().startsWith('- ')) break;
        stepEnd++;
      }
      return [stepStart, stepEnd];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// rb-20 (residual R-m23-s11-X11), RM-1 / RM-2. `client/playwright.config.ts`
// gains a `projects:` array (ADR-0219). This predicate closes two doors:
//   * the `reduced-motion` project must exist, be scoped to a project-level
//     `use.contextOptions.reducedMotion`, and use the SPELLING that actually
//     exists on this repo's pinned @playwright/test 1.61.1 (ADR-0219 D5) —
//     the shorthand `use: { reducedMotion: 'reduce' }` compiles nowhere near
//     this version and is a silent runtime no-op even forced past the type
//     system;
//   * the collection boundary is closed on BOTH sides (ADR-0219 D2): the
//     `default` project must NOT collect the new spec (or it runs unemulated
//     and reds every PR), and the `reduced-motion` project must NOT ALSO
//     collect `a11y.spec.ts` (a second context on that file breaks its own
//     documented single-context contract).
// Pure text-in/verdict-out, like every predicate in this file — comment-
// stripped but NOT a real JS/TS parser, so it is driven by STRING SHAPE, not
// AST semantics. That is deliberate and matches this file's existing style
// (e.g. `extractRecipeBodyLocal`) rather than importing a TS compiler into a
// CI gate.
//
// NO BARE FIRST-HIT ANCHORS. Every structural anchor below (`projects:`, each
// project NAME, the recipe header, the `case` guard header) is COUNTED and
// rejected on a duplicate rather than resolved with `indexOf`. This repo has a
// measured history of first-hit anchors being steered by a planted decoy
// string literal, and the failure mode is a silent false-green, not an error.
// ---------------------------------------------------------------------------
const RM_SPEC_NAME = 'reduced-motion.spec.ts';
const A11Y_SPEC_NAME = 'a11y.spec.ts';

function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  return haystack.split(needle).length - 1;
}

// The index that closes the bracket opened at `openIdx` (whose characters are
// `openCh`/`closeCh`), quote-aware so a bracket character inside a string
// literal cannot desync the walk. Returns -1 on unbalanced input.
function matchBalancedBracket(text, openIdx, openCh, closeCh) {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Every top-level `{...}` object literal directly inside an array's body text
// (i.e. each ELEMENT of the array, regardless of how deeply its OWN contents
// nest) — quote-aware for the same reason as matchBalancedBracket.
function topLevelObjectLiterals(arrayBody) {
  const out = [];
  let quote = null;
  for (let i = 0; i < arrayBody.length; i += 1) {
    const ch = arrayBody[i];
    if (quote !== null) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') {
      const close = matchBalancedBracket(arrayBody, i, '{', '}');
      if (close === -1) break;
      out.push(arrayBody.slice(i, close + 1));
      i = close;
    }
  }
  return out;
}

// `{ projectsFound, ambiguous, blocks, stripped, projectsKeyIndex }` — `blocks`
// is every top-level project object literal inside `projects: [ ... ]`.
// `ambiguous` is set when the comment-stripped source carries MORE THAN ONE
// `projects:` token: the honest answer there is "I cannot tell which array is
// the config's", never "here is the first one" (see the no-bare-anchors note
// above).
function extractPlaywrightProjects(configText) {
  const stripped = stripJsComments(configText);
  const key = 'projects:';
  const hits = countOccurrences(stripped, key);
  const empty = {
    projectsFound: false,
    ambiguous: false,
    blocks: [],
    stripped,
    projectsKeyIndex: -1,
  };
  if (hits === 0) return empty;
  if (hits > 1) return { ...empty, ambiguous: true };
  const at = stripped.indexOf(key);
  const open = stripped.indexOf('[', at);
  if (open === -1) return { ...empty, projectsKeyIndex: at };
  const close = matchBalancedBracket(stripped, open, '[', ']');
  if (close === -1) return { ...empty, projectsKeyIndex: at };
  const body = stripped.slice(open + 1, close);
  return {
    projectsFound: true,
    ambiguous: false,
    blocks: topLevelObjectLiterals(body),
    stripped,
    projectsKeyIndex: at,
  };
}

// Every project block naming `projectName` — plural on purpose, so a duplicate
// declaration is REPORTED rather than silently resolved to the first.
function projectBlocksNamed(blocks, projectName) {
  return blocks.filter(
    (b) => b.indexOf(`name: '${projectName}'`) !== -1 || b.indexOf(`name: "${projectName}"`) !== -1,
  );
}

export function reducedMotionProjectIsWired(configText) {
  const { projectsFound, ambiguous, blocks, stripped, projectsKeyIndex } =
    extractPlaywrightProjects(configText);
  if (ambiguous) {
    return {
      ok: false,
      reason:
        'client/playwright.config.ts carries MORE THAN ONE `projects:` token outside comments — ' +
        "this gate refuses to guess which array is the config's, because a first-hit anchor is " +
        'steerable by a planted decoy (measured elsewhere in this repo) and the resulting ' +
        'false-green is silent',
    };
  }
  if (!projectsFound || blocks.length === 0) {
    return {
      ok: false,
      reason:
        'client/playwright.config.ts declares no `projects:` array — RM-1 requires a DEDICATED ' +
        'reduced-motion PROJECT, not a config-wide setting',
    };
  }

  const rmBlocks = projectBlocksNamed(blocks, 'reduced-motion');
  if (rmBlocks.length === 0) {
    return {
      ok: false,
      reason: "no project named 'reduced-motion' is declared inside `projects:` — RM-1",
    };
  }
  if (rmBlocks.length > 1) {
    return {
      ok: false,
      reason: `${rmBlocks.length} projects are named 'reduced-motion' — exactly one is required, or which project this gate describes is ambiguous`,
    };
  }
  const rm = rmBlocks[0];

  const defBlocks = projectBlocksNamed(blocks, 'default');
  if (defBlocks.length === 0) {
    return {
      ok: false,
      reason:
        "no project named 'default' is declared inside `projects:` — RM-2 requires the default " +
        'project to explicitly exclude the new spec, and without a default project every OTHER ' +
        'e2e spec has no home to collect from',
    };
  }
  if (defBlocks.length > 1) {
    return {
      ok: false,
      reason: `${defBlocks.length} projects are named 'default' — exactly one is required, or which project this gate describes is ambiguous`,
    };
  }
  const def = defBlocks[0];

  // ADR-0219 D5, MEASURED: the shorthand `use: { reducedMotion: 'reduce' }`
  // does not exist on this repo's pinned @playwright/test 1.61.1 UseOptions
  // type (TS2769) and is a silent runtime no-op even forced past the type
  // system. Checked BEFORE looking for the correct spelling, so the failure
  // message names the trap rather than reporting a generic "no contextOptions".
  if (rm.indexOf('reducedMotion') !== -1 && rm.indexOf('contextOptions') === -1) {
    return {
      ok: false,
      reason:
        "the 'reduced-motion' project sets `reducedMotion` OUTSIDE `contextOptions` — ADR-0219 " +
        "D5: that shorthand (`use: { reducedMotion: 'reduce' }`) does not exist on this repo's " +
        'pinned @playwright/test 1.61.1 (fails client-typecheck with TS2769) and is a silent ' +
        'runtime no-op even if forced past the type system. Use ' +
        "`use: { contextOptions: { reducedMotion: 'reduce' } }`.",
    };
  }

  // NESTING DEPTH IS PART OF THE CRITERION, not a formality (rb-20 artifact red-team,
  // finding 1). Playwright promotes `use.contextOptions` into the real
  // `browser.newContext()` call; a `contextOptions` that is a SIBLING of `use` rather
  // than a member of it is ignored entirely at runtime. TypeScript rejects the plain
  // sibling form as an excess property — but a one-line spread
  // (`...({ contextOptions: { reducedMotion: 'reduce' } })`) defeats the excess-property
  // check, typechecks clean, and was MEASURED to satisfy an earlier version of this
  // predicate over a project whose real `use` was `{}`. So resolve the project's OWN
  // `use: { ... }` body first and look for `contextOptions` only inside it.
  const useIdx = rm.indexOf('use:');
  if (useIdx === -1) {
    return {
      ok: false,
      reason:
        "the 'reduced-motion' project declares no `use:` block — RM-1 requires " +
        "`use: { contextOptions: { reducedMotion: 'reduce' } }`",
    };
  }
  const useOpen = rm.indexOf('{', useIdx);
  const useClose = useOpen === -1 ? -1 : matchBalancedBracket(rm, useOpen, '{', '}');
  if (useOpen === -1 || useClose === -1) {
    return { ok: false, reason: "the 'reduced-motion' project's `use:` block is unbalanced" };
  }
  const useBody = rm.slice(useOpen + 1, useClose);
  const ctxIdx = useBody.indexOf('contextOptions');
  if (ctxIdx === -1) {
    return {
      ok: false,
      reason:
        "the 'reduced-motion' project's `use:` block carries no `contextOptions` — RM-1 requires " +
        "`use: { contextOptions: { reducedMotion: 'reduce' } }`. A `contextOptions` declared " +
        'OUTSIDE `use` (including one injected by a spread, which typechecks clean) is ignored ' +
        'by Playwright at runtime and gates nothing.',
    };
  }
  const ctxOpen = useBody.indexOf('{', ctxIdx);
  const ctxClose = ctxOpen === -1 ? -1 : matchBalancedBracket(useBody, ctxOpen, '{', '}');
  const ctxBody = ctxOpen === -1 || ctxClose === -1 ? '' : useBody.slice(ctxOpen + 1, ctxClose);
  if (ctxBody.indexOf('reducedMotion') === -1) {
    return {
      ok: false,
      reason:
        "the 'reduced-motion' project's `contextOptions` block carries no `reducedMotion` key",
    };
  }
  if (ctxBody.indexOf("'reduce'") === -1 && ctxBody.indexOf('"reduce"') === -1) {
    return {
      ok: false,
      reason:
        "the 'reduced-motion' project's `contextOptions.reducedMotion` is not exactly 'reduce' " +
        '— RM-1 requires exactly `reduce`, not `no-preference` or any other value',
    };
  }

  // RM-1: the option must not ALSO be hoisted to the config's top-level `use:`
  // block (the one outside every project, which Playwright merges into ALL of
  // them) — that would force the entire 20-file e2e suite into reduced
  // motion, invisibly to RM-2's collection counts. Scoped to the text BEFORE
  // `projects:` starts, matching this config's own convention (config-level
  // keys precede the `projects:` array).
  const topLevel = stripped.slice(0, projectsKeyIndex);
  if (topLevel.indexOf('reducedMotion') !== -1) {
    return {
      ok: false,
      reason:
        'a config-level (pre-`projects:`) block mentions `reducedMotion` — RM-1 requires the ' +
        'option scoped to the reduced-motion PROJECT alone; hoisting it earlier silently forces ' +
        'the entire e2e suite into reduced motion',
    };
  }

  // ADR-0219 D2 (RM-2), both sides of the collection boundary.
  if (def.indexOf('testIgnore') === -1 || def.indexOf(RM_SPEC_NAME) === -1) {
    return {
      ok: false,
      reason:
        `the 'default' project does not \`testIgnore\` '${RM_SPEC_NAME}' — RM-2: without it the ` +
        'new spec is ALSO collected by `default` with no emulation, and its first assertion ' +
        '(matches === true) fails on every PR',
    };
  }
  if (rm.indexOf('testMatch') === -1 || rm.indexOf(RM_SPEC_NAME) === -1) {
    return {
      ok: false,
      reason:
        `the 'reduced-motion' project carries no \`testMatch\` naming '${RM_SPEC_NAME}' — ` +
        'without it, testDir-based collection picks up every e2e spec, including a11y.spec.ts ' +
        '(ADR-0219 D2)',
    };
  }
  // ESCAPE-STRIPPED, because `testMatch` accepts RegExp literals as well as strings and
  // `/a11y\\.spec\\.ts$/` contains no literal `a11y.spec.ts` substring while collecting
  // exactly that file (MEASURED against the real Playwright collector: 2 files / 5 tests).
  // The bite-proof's `CFG-widen-testMatch` mutant only tried the string-array form, so the
  // 19-mutant set was blind to this until the artifact red-team pass found it.
  const rmUnescaped = rm.split('\\').join('');
  if (rm.indexOf(A11Y_SPEC_NAME) !== -1 || rmUnescaped.indexOf(A11Y_SPEC_NAME) !== -1) {
    return {
      ok: false,
      reason:
        `the 'reduced-motion' project's testMatch also names '${A11Y_SPEC_NAME}' — ADR-0219 D2 ` +
        'requires a11y.spec.ts NOT run under reduced motion (its own header forbids a second ' +
        "context; golden.spec.ts's exact presenceCount===2 assertion would break under a leaked " +
        'second context)',
    };
  }

  return {
    ok: true,
    reason:
      "client/playwright.config.ts declares a 'reduced-motion' project scoped to " +
      "`contextOptions.reducedMotion: 'reduce'`, a 'default' project that testIgnores the new " +
      'spec, the option is not hoisted to a config-level `use:`, and neither project collects ' +
      "the other's spec",
  };
}

// ---------------------------------------------------------------------------
// Duplicate-key guard helpers (F1 / F9).
//
// GitHub Actions last-key-wins: if `ci:` appears twice under `jobs:`, the
// second (possibly neutered) definition is what runners execute. extractJobBlock
// only sees the FIRST block — so a clean first + neutered second silently passes.
// We scan the raw yaml for duplicate job-key lines at 2-space indent (F1) and
// duplicate `jobs:` lines at 0-space indent (F9).
//
// LATENT ASSUMPTION: GitHub Actions job keys are at 2-space indent, top-level
// keys (including `jobs:`) are at 0-indent. This matches the GHA YAML spec.
// ---------------------------------------------------------------------------
function checkNoDuplicateJobKey(yaml, jobName) {
  // A job-key line looks like: `  <name>:` at exactly 2-space indent.
  const target = `  ${jobName}:`;
  let count = 0;
  for (const line of yaml.split('\n')) {
    if (line === target || line.startsWith(`${target} `)) {
      count++;
      if (count > 1) {
        return {
          ok: false,
          reason: `duplicate job key '${jobName}:' detected at 2-space indent — GitHub Actions last-key-wins; the second (possibly neutered) block would execute`,
        };
      }
    }
  }
  return { ok: true, reason: `no duplicate '${jobName}:' job key` };
}

function checkNoDuplicateJobsKey(yaml) {
  let count = 0;
  for (const line of yaml.split('\n')) {
    if (line === 'jobs:' || line.startsWith('jobs: ')) {
      count++;
      if (count > 1) {
        return {
          ok: false,
          reason:
            'duplicate top-level `jobs:` key detected — GitHub Actions last-key-wins; the second jobs block (possibly neutered) would execute',
        };
      }
    }
  }
  return { ok: true, reason: 'no duplicate top-level `jobs:` key' };
}

// ---------------------------------------------------------------------------
// Predicate 1: ciStepsUnneutered(yaml) → { ok, reason }
//
// Rules:
//  - Empty ci block → { ok:false } (no vacuous pass)
//  - Duplicate `ci:` job key at 2-space indent → fail (F1, last-key-wins bypass)
//  - Duplicate top-level `jobs:` key at 0-indent → fail (F9, same class)
//  - Job-level if:/truthy continue-on-error → fail
//  - For each required verb: must have a non-comment line whose TRIMMED form is
//    EXACTLY `- run: just <verb>` (no suffixes like `|| true`, `; exit 0`, `&& …`)
//  - Within that step's line range: no trimmed `if:` and no truthy `continue-on-error:`
// ---------------------------------------------------------------------------
export function ciStepsUnneutered(yaml) {
  // F9: duplicate `jobs:` key guard.
  const dupJobs = checkNoDuplicateJobsKey(yaml);
  if (!dupJobs.ok) return dupJobs;

  const block = extractJobBlock(yaml, 'ci');
  if (!block || block.trim() === '') {
    return { ok: false, reason: 'ci job block is empty or absent (no vacuous pass)' };
  }

  // F1: duplicate `ci:` job key guard.
  const dupCi = checkNoDuplicateJobKey(yaml, 'ci');
  if (!dupCi.ok) return dupCi;

  // Job-level keys sit at 4-space indent (before `steps:`).
  // Check job-level if: and continue-on-error: (keys that appear before the steps: key).
  // LATENT ASSUMPTION: in GitHub Actions YAML, job-level keys (runs-on, if,
  // continue-on-error, env, …) always precede the `steps:` key. We scan lines
  // until we see `steps:` and then stop — this is correct by design because any
  // `if:` appearing after `steps:` is a step-level condition, caught by the per-step
  // range inspection below.
  const blockLines = block.split('\n');
  let pastSteps = false;
  for (const line of blockLines) {
    const tr = line.trim();
    if (tr === 'steps:' || tr.startsWith('steps:')) {
      pastSteps = true;
      continue;
    }
    if (pastSteps) break; // only check pre-steps job-level keys
    if (tr.startsWith('if:')) {
      return {
        ok: false,
        reason: `ci job has a job-level if: condition — can disable the entire job`,
      };
    }
    if (tr.startsWith('continue-on-error:')) {
      const value = tr.slice('continue-on-error:'.length).trim();
      if (isTruthyCoe(value)) {
        return { ok: false, reason: `ci job has a truthy job-level continue-on-error: ${value}` };
      }
    }
  }

  // For each required verb, find the exact step and inspect within its range.
  const allLines = yaml.split('\n');

  for (const verb of REQUIRED_JUST_STEPS) {
    const exactStep = `- run: just ${verb}`;
    // Find a non-comment line in the ci block whose TRIMMED form is EXACTLY `- run: just <verb>`.
    let found = false;
    let stepRangeResult = null;

    for (let i = 0; i < allLines.length; i++) {
      const tr = allLines[i].trim();
      // Skip comment lines.
      if (tr.startsWith('#')) continue;
      if (tr === exactStep) {
        // Confirm this line is inside the ci job block. The block starts with `  ci:`.
        // We do this by checking extractJobBlock for this line's presence.
        // Simpler: re-extract the block and check its lines.
        const ciBlockLines = block.split('\n');
        if (ciBlockLines.some((bl) => bl.trim() === exactStep && !bl.trim().startsWith('#'))) {
          found = true;
          stepRangeResult = findStepRange(allLines, allLines[i]);
          break;
        }
      }
    }

    if (!found) {
      return {
        ok: false,
        reason: `ci job is missing an exact '- run: just ${verb}' step (found none matching — rejects suffixes like || true, ; exit 0, && …, or a run: | block with shell conditionals)`,
      };
    }

    // Inspect within the step's range for step-level if:/continue-on-error:.
    if (stepRangeResult !== null) {
      const [start, end] = stepRangeResult;
      for (let i = start; i < end; i++) {
        const tr = allLines[i].trim();
        if (tr.startsWith('#')) continue;
        if (tr.startsWith('if:')) {
          return {
            ok: false,
            reason: `step 'run: just ${verb}' has a step-level if: condition — can skip/disable the step`,
          };
        }
        if (tr.startsWith('continue-on-error:')) {
          const value = tr.slice('continue-on-error:'.length).trim();
          if (isTruthyCoe(value)) {
            return {
              ok: false,
              reason: `step 'run: just ${verb}' has a truthy step-level continue-on-error: ${value}`,
            };
          }
        }
      }
    }
  }

  return { ok: true, reason: 'ci job has all required steps, unneutered, exact run: just <verb>' };
}

// ---------------------------------------------------------------------------
// Predicate 2: justfileCiDepsAppearInCi(justfileText, ciYaml) → { ok, reason }
//
// Parse the `ci:` recipe line; split deps. Every dep except `security` must
// appear as an exact `- run: just <dep>` in the ci: job block. `security` is
// satisfied by ALL FOUR markers: gitleaks/gitleaks-action (uses), cargo audit
// (run), semgrep scan (run), anchore/sbom-action (uses).
// Also assert the justfile ci: line still lists all REQUIRED_JUST_STEPS + security.
// ---------------------------------------------------------------------------
export function justfileCiDepsAppearInCi(justfileText, ciYaml) {
  // Find the ci: recipe line (column 0).
  let ciLine = '';
  for (const line of justfileText.split('\n')) {
    if (line.startsWith('ci:') || line.startsWith('ci ')) {
      ciLine = line;
      break;
    }
  }
  if (!ciLine) {
    return { ok: false, reason: 'justfile has no `ci:` recipe line at column 0' };
  }

  // Deps follow the colon.
  const colonIdx = ciLine.indexOf(':');
  const depsStr = colonIdx !== -1 ? ciLine.slice(colonIdx + 1).trim() : '';
  const deps = depsStr.split(/\s+/).filter(Boolean);

  // Check justfile contains all REQUIRED_JUST_STEPS + security.
  const required = [...REQUIRED_JUST_STEPS, 'security'];
  for (const req of required) {
    if (!deps.includes(req)) {
      return {
        ok: false,
        reason: `justfile ci: recipe is missing required dep '${req}' (the dep must not be removed from the justfile — the hardcoded oracle catches this direction)`,
      };
    }
  }

  const ciBlock = extractJobBlock(ciYaml, 'ci');

  // Check each dep against ci.yml.
  for (const dep of deps) {
    if (dep === 'security') {
      // Substitution: all four markers must be present on non-comment lines.
      // F2: raw indexOf would accept all four markers inside a single `# …` comment
      // with no actual security steps. We line-scan, skipping lines whose TRIMMED
      // form starts with `#`.
      const markers = [
        'gitleaks/gitleaks-action',
        'cargo audit',
        'semgrep scan',
        'anchore/sbom-action',
      ];
      const ciLines = ciYaml.split('\n');
      for (const marker of markers) {
        const foundOnNonComment = ciLines.some(
          (ln) => !ln.trim().startsWith('#') && ln.indexOf(marker) !== -1,
        );
        if (!foundOnNonComment) {
          return {
            ok: false,
            reason: `security dep substitution incomplete: marker '${marker}' not found on any non-comment line in ci.yml (all four required: gitleaks/gitleaks-action uses, cargo audit run, semgrep scan run, anchore/sbom-action uses; markers appearing only in comments do not satisfy the gate)`,
          };
        }
      }
    } else {
      // Must appear as exact `- run: just <dep>` in the ci: job block.
      const exactStep = `- run: just ${dep}`;
      const blockLines = ciBlock.split('\n');
      const found = blockLines.some((bl) => bl.trim() === exactStep && !bl.trim().startsWith('#'));
      if (!found) {
        return {
          ok: false,
          reason: `justfile ci: dep '${dep}' has no exact '- run: just ${dep}' step in the ci: job block of ci.yml`,
        };
      }
    }
  }

  return {
    ok: true,
    reason: 'all justfile ci: deps appear in ci.yml (security via 4-marker substitution)',
  };
}

// ---------------------------------------------------------------------------
// Predicate 3: ciRecipeBodiesIntact(justfileText) → { ok, reason }
//
// Recipe-body guard: gut the recipe, leave ci.yml pristine → still caught.
//   test:  must contain `cargo nextest run --workspace` AND `cargo test --doc --workspace`
//   eval:  must contain `node evals/run.mjs`
//   client-test: must contain `npm test`
// ---------------------------------------------------------------------------

// Local recipe-body extractor. extractRecipeBody from ./build-ci-hygiene.eval.mjs
// exports the same logic and could be imported, but adding a second dynamic-import
// dependency here would require another try/catch guard at the top of the default
// export. The duplication is small (~30 lines), semantics are identical, and keeping
// it local avoids a second cross-eval coupling. If this diverges from build-ci-hygiene
// in the future, consolidate via a shared utility module.
function extractRecipeBodyLocal(text, recipeName) {
  const exactMarker = `\n${recipeName}:`;
  const paramMarker = `\n${recipeName} `;
  const exactIdx = text.indexOf(exactMarker);
  const paramIdx = text.indexOf(paramMarker);

  let headerIdx = -1;
  if (exactIdx !== -1 && paramIdx !== -1) headerIdx = Math.min(exactIdx, paramIdx);
  else if (exactIdx !== -1) headerIdx = exactIdx;
  else if (paramIdx !== -1) headerIdx = paramIdx;

  if (headerIdx === -1) {
    if (text.startsWith(`${recipeName}:`) || text.startsWith(`${recipeName} `)) {
      headerIdx = 0;
    } else {
      return '';
    }
  }

  const afterHeader = text.indexOf('\n', headerIdx === 0 ? 0 : headerIdx + 1);
  if (afterHeader === -1) return '';

  let body = '';
  let pos = afterHeader + 1;
  while (pos < text.length) {
    const lineEnd = text.indexOf('\n', pos);
    const line = lineEnd === -1 ? text.slice(pos) : text.slice(pos, lineEnd);
    if (line.length > 0 && (line[0] === ' ' || line[0] === '\t')) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith('#')) body += `${line}\n`;
      pos = lineEnd === -1 ? text.length : lineEnd + 1;
    } else if (line.length === 0) {
      pos = lineEnd === -1 ? text.length : lineEnd + 1;
    } else {
      break;
    }
  }
  return body;
}

export function ciRecipeBodiesIntact(justfileText) {
  const testBody = extractRecipeBodyLocal(justfileText, 'test');
  if (!testBody) {
    return { ok: false, reason: 'justfile test: recipe body is empty or absent' };
  }
  if (testBody.indexOf('cargo nextest run --workspace') === -1) {
    return { ok: false, reason: 'justfile test: body missing `cargo nextest run --workspace`' };
  }
  if (testBody.indexOf('cargo test --doc --workspace') === -1) {
    return { ok: false, reason: 'justfile test: body missing `cargo test --doc --workspace`' };
  }

  const evalBody = extractRecipeBodyLocal(justfileText, 'eval');
  if (!evalBody) {
    return { ok: false, reason: 'justfile eval: recipe body is empty or absent' };
  }
  if (evalBody.indexOf('node evals/run.mjs') === -1) {
    return { ok: false, reason: 'justfile eval: body missing `node evals/run.mjs`' };
  }

  const clientTestBody = extractRecipeBodyLocal(justfileText, 'client-test');
  if (!clientTestBody) {
    return { ok: false, reason: 'justfile client-test: recipe body is empty or absent' };
  }
  if (clientTestBody.indexOf('npm test') === -1) {
    return { ok: false, reason: 'justfile client-test: body missing `npm test`' };
  }

  return { ok: true, reason: 'test/eval/client-test recipe bodies are intact' };
}

// ---------------------------------------------------------------------------
// Predicate 4: runMjsIsIntact(runMjsText) → { ok, reason }
//
// run.mjs cannot guard itself from under `just eval`; this eval also runs from
// the e2e-job anchor, breaking the circularity.
// Require: `files.length === 0` (zero-eval guard), `pass: false`, `process.exit(1)`, `catch`.
// ---------------------------------------------------------------------------
export function runMjsIsIntact(runMjsText) {
  if (runMjsText.indexOf('files.length === 0') === -1) {
    return { ok: false, reason: 'evals/run.mjs missing zero-eval guard (files.length === 0)' };
  }
  if (runMjsText.indexOf('pass: false') === -1) {
    return { ok: false, reason: 'evals/run.mjs missing per-eval synthetic failure (pass: false)' };
  }
  if (runMjsText.indexOf('process.exit(1)') === -1) {
    return { ok: false, reason: 'evals/run.mjs missing process.exit(1)' };
  }
  if (runMjsText.indexOf('catch') === -1) {
    return { ok: false, reason: 'evals/run.mjs missing catch (per-eval try/catch guard)' };
  }
  return { ok: true, reason: 'run.mjs structural invariants intact' };
}

// ---------------------------------------------------------------------------
// Predicate 5: anchorIsWired(lefthookText, ciYaml) → { ok, reason }
//
// lefthook.yml must contain `node evals/ci-gate-wiring.eval.mjs` (indexOf),
// AND the `e2e` job block of ciYaml must contain a non-comment trimmed line
// exactly `- run: node evals/ci-gate-wiring.eval.mjs`.
// ---------------------------------------------------------------------------
export function anchorIsWired(lefthookText, ciYaml) {
  // F3: the lefthook check was comment-blind (raw indexOf). A line like
  //   `# run: node evals/ci-gate-wiring.eval.mjs` would satisfy it falsely.
  // Fix: line-scan, skipping any line whose trimmed form starts with `#`.
  const ANCHOR_TOKEN = 'node evals/ci-gate-wiring.eval.mjs';
  const foundInLefthook = lefthookText
    .split('\n')
    .some((ln) => !ln.trim().startsWith('#') && ln.indexOf(ANCHOR_TOKEN) !== -1);
  if (!foundInLefthook) {
    return {
      ok: false,
      reason:
        'lefthook.yml does not contain `node evals/ci-gate-wiring.eval.mjs` on a non-comment line — add it under a pre-commit command so the gate runs locally before every commit',
    };
  }

  const e2eBlock = extractJobBlock(ciYaml, 'e2e');
  if (!e2eBlock || e2eBlock.trim() === '') {
    return { ok: false, reason: 'ci.yml has no e2e job block — cannot verify anchor step' };
  }
  const exactAnchorStep = '- run: node evals/ci-gate-wiring.eval.mjs';
  const e2eLines = e2eBlock.split('\n');
  const found = e2eLines.some((ln) => {
    const tr = ln.trim();
    return tr === exactAnchorStep && !tr.startsWith('#');
  });
  if (!found) {
    return {
      ok: false,
      reason: `e2e job in ci.yml is missing exact step '- run: node evals/ci-gate-wiring.eval.mjs' — add it so the anchor runs in CI without being evaluated by just eval itself`,
    };
  }

  return { ok: true, reason: 'anchor wired in lefthook.yml and e2e job' };
}

// ---------------------------------------------------------------------------
// Main-guard structural check: this file's own source must contain the
// main-guard pattern so the anchor cannot silently become a no-op import.
// ---------------------------------------------------------------------------
function selfContainsMainGuard(src) {
  // Require the key tokens that constitute the main-guard.
  // ciGateWiringEval: proves the named function exists and is called directly
  // (not via dynamic self-import, which deadlocks on top-level await).
  return (
    src.indexOf('process.argv[1]') !== -1 &&
    src.indexOf('fileURLToPath(import.meta.url)') !== -1 &&
    src.indexOf('ciGateWiringEval') !== -1 &&
    src.indexOf('process.exit(result.pass ? 0 : 1)') !== -1
  );
}

// ---------------------------------------------------------------------------
// m23-s11 (spec §5.7 "CI vs nightly — DECIDED"): the two ADDITIVE checks that
// gate the nightly a11y tier. Both are deliberately narrow — §5.7 asks for "a
// cheap additive wiring check … that the recipe exists and is invoked by the
// nightly workflow with a non-truthy continue-on-error", NOT a mutation of
// REQUIRED_JUST_STEPS (which stays byte-identical: `a11y-e2e` must never become
// a `ci:` dep, or the ADR-0043 fast hermetic loop grows a browser and a server).
//
// NO `new RegExp(...)`: String methods plus the pre-existing literal-regex
// helper isTruthyCoe only (detect-non-literal-regexp, 3 prior bites).
// ---------------------------------------------------------------------------

// The three shipped a11y evals the recipe's first half imports BY NAME. Pinned
// here as well as in the recipe on purpose: `evals/run.mjs` fails only at ZERO
// eval files, so deleting one of these leaves `just eval` green with one fewer
// check. This list is what makes that deletion visible.
const A11Y_EVAL_FILES = [
  'overlay-a11y-manifest.eval.mjs',
  'a11y-static-shell.eval.mjs',
  'reduced-motion-purity.eval.mjs',
];

// The one vitest spec the recipe's second half must name explicitly. It is the
// cross-view wiring totality spec (m23-s10) — the single largest a11y suite and
// the one whose silent deletion `just client-test` cannot see (a MISSING spec
// reports numTotalTests:0 and exits 0).
const A11Y_PINNED_SPEC = 'overlayA11yWiring.test.ts';

// The recipe name, in one place: it is asserted PRESENT in the nightly workflow and
// ABSENT from every hermetic-gate surface, and those two must never disagree.
const A11Y_RECIPE_NAME = 'a11y-e2e';

// The exact, UNSUFFIXED step line the nightly job must carry.
const A11Y_NIGHTLY_STEP = '- run: just a11y-e2e';

// ---------------------------------------------------------------------------
// rb-19: the axe-core + real-browser tier — the half m23-s11 explicitly deferred
// (ledger X10/X11), and whose DEFERRED banner the recipe printed until rb-19. Half 3
// of `just a11y-e2e` runs a Playwright spec that drives the real client and scans
// three page states with axe-core. These are the tokens that half must put in the
// recipe body, plus the now-FALSE banner it must stop printing.
//
// The banner clause is a NEGATIVE and it is not cosmetic: once Half 3 ships,
// "axe-core + real-browser tier is NOT run here" is a false statement emitted by a
// GREEN gate, which is the worst kind of evidence — it tells a future reader the
// coverage gap is still open when it is closed, and it tells the next auditor the
// recipe is honest when it is not. Restoring the line must bite. The SEPARATE
// A11Y-32 / A11Y-33 manual banner stays: those two criteria really are never
// CI-green (docs/a11y-manual-protocol.md).
// ---------------------------------------------------------------------------
const A11Y_AXE_SPEC_PATH = 'e2e/a11y.spec.ts';
const A11Y_AXE_RECIPE_TOKENS = [
  'playwright test',
  A11Y_AXE_SPEC_PATH,
  'PLAYWRIGHT_JSON_OUTPUT_NAME',
  'A11Y-AXE OK',
];
const A11Y_AXE_STALE_BANNER = 'DEFERRED: axe-core';

// NOT redundant with a11yRecipeBodyIsPinned below, though on an unchanged tree it can only agree
// with it: the two answer different questions across a DELIBERATE recipe edit. The verbatim pin
// says "nothing moved"; the moment someone legitimately changes the recipe they update the pin in
// the same commit and the pin goes quiet — and these token clauses are what still has to hold
// afterwards. Deleting either one leaves a real hole: without the pin, tokens can sit above an
// `exit 0` (red-team executed it); without the tokens, a pin update can silently drop a whole half
// of the recipe.
export function a11yRecipeBodyIntact(justfileText) {
  // extractRecipeBodyLocal already strips `#` lines and already handles the
  // `name param=: dep` header form, so a token that appears ONLY in a comment
  // never reaches us — that is the fixture corpus's "tokens-in-comment" tooth.
  const body = extractRecipeBodyLocal(justfileText, 'a11y-e2e');
  if (!body) {
    return {
      ok: false,
      reason:
        'justfile a11y-e2e: recipe body is empty or absent (a comment-only body extracts to nothing)',
    };
  }
  if (body.indexOf('set -euo pipefail') === -1) {
    return {
      ok: false,
      reason:
        'justfile a11y-e2e: body missing `set -euo pipefail` — without it a failing half is swallowed and the gate exits 0 vacuously',
    };
  }
  if (body.indexOf('vitest run') === -1) {
    return {
      ok: false,
      reason: 'justfile a11y-e2e: body missing `vitest run` — no real test runner',
    };
  }
  if (body.indexOf('--reporter=json') === -1) {
    return {
      ok: false,
      reason:
        'justfile a11y-e2e: body missing `--reporter=json` — the floor can only be asserted from the machine-readable report, never from the last line of console output',
    };
  }
  if (body.indexOf(A11Y_PINNED_SPEC) === -1) {
    return {
      ok: false,
      reason: `justfile a11y-e2e: body never names \`${A11Y_PINNED_SPEC}\` — running vitest over some other spec proves nothing about the a11y tier`,
    };
  }
  for (const evalFile of A11Y_EVAL_FILES) {
    if (body.indexOf(evalFile) === -1) {
      return {
        ok: false,
        reason: `justfile a11y-e2e: body never names \`${evalFile}\` — that a11y eval could be deleted with the whole suite staying green`,
      };
    }
  }
  // --- rb-19 Half 3 (axe-core over the real browser). Same division of labour as
  // the clauses above versus a11yRecipeBodyIsPinned: the verbatim region pin says
  // "nothing moved"; these token clauses say what still has to hold across a
  // DELIBERATE recipe edit, when the pin has been legitimately regenerated and has
  // therefore gone quiet.
  for (const token of A11Y_AXE_RECIPE_TOKENS) {
    if (body.indexOf(token) === -1) {
      return {
        ok: false,
        reason: `justfile a11y-e2e: body never names '${token}' — Half 3 (axe-core driving the real client, m23-s11 ledger X10/X11) is not wired, so the a11y tier still proves nothing about the RENDERED page`,
      };
    }
  }
  if (body.indexOf(A11Y_AXE_STALE_BANNER) !== -1) {
    return {
      ok: false,
      reason: `justfile a11y-e2e: body still prints the stale '${A11Y_AXE_STALE_BANNER}' deferral banner — Half 3 now RUNS that tier, so the line is a false statement emitted by a green gate. Delete it; the separate A11Y-32 / A11Y-33 MANUAL banner stays.`,
    };
  }
  return {
    ok: true,
    reason: `justfile a11y-e2e: body is fail-closed and pins ${A11Y_EVAL_FILES.length} a11y eval(s) plus ${A11Y_PINNED_SPEC}, and Half 3 scans ${A11Y_AXE_SPEC_PATH} with axe-core`,
  };
}

// ---------------------------------------------------------------------------
// m23-s11 ROUND 2 (red-team, EXECUTED bypass). `a11yRecipeBodyIntact` above is a
// pure substring scan, and red-team PROVED the consequence end to end: insert
// `exit 0` immediately after `set -euo pipefail` and leave the rest of the body
// byte-identical below it, and the predicate still returns ok (every required
// token is present), while `just a11y-e2e` runs NOTHING and exits 0. Dead
// branches (`if false; then ... fi`) and heredoc payloads bypass it the same way.
//
// A blacklist of abort constructs does NOT close this — measured elsewhere in
// this repo: sixteen CI-clean bypasses beat one such blacklist. The house remedy
// is to PIN THE BLOCK VERBATIM (the CHANGELOG_RECIPE_BODY / mutate-server
// idiom), which is closable by construction: ANY edit to the region reds the
// gate, and the fix is to update this constant in the SAME commit, deliberately.
//
// This pins the RAW region (header line through the last indented line),
// deliberately NOT the comment-stripped body: the stripper drops `#` lines, so a
// body pin would let the `#!/usr/bin/env bash` shebang be deleted silently, and
// would let a decoy comment be planted inside the recipe unnoticed.
//
// LOCKSTEP: the justfile `a11y-e2e` recipe and this constant move together, or
// the gate is red. That is the point, not an inconvenience.
// ---------------------------------------------------------------------------
export const A11Y_E2E_RECIPE_REGION =
  "a11y-e2e floor=\"169\" axefloor=\"3\" rmfloor=\"2\": wasm\n    #!/usr/bin/env bash\n    set -euo pipefail\n    # Fail loud on a malformed floor BEFORE the run. BOTH floors are guarded, and\n    # the axe one is not decoration: it reaches `Number(process.argv[1])`, and\n    # `Number('')` is 0 while `Number('abc')` is NaN — `s.expected < NaN` is FALSE,\n    # so an empty or non-numeric axefloor makes half 3 print A11Y-AXE OK on a\n    # ZERO-test report. That is the same vacuous-green class ADR-0183 D7 records\n    # for `[ \"\" -gt N ]` in a set -e-exempt if-condition, arriving by a different\n    # route; the two `node -e` blocks below compare numerically rather than with\n    # `[ -gt ]`, so this `case` is the whole guard.\n    case \"{{floor}}\" in\n        ''|*[!0-9]*) echo \"a11y-e2e: floor '{{floor}}' is not a non-negative integer\" >&2; exit 64;;\n    esac\n    case \"{{axefloor}}\" in\n        ''|*[!0-9]*) echo \"a11y-e2e: axefloor '{{axefloor}}' is not a non-negative integer\" >&2; exit 64;;\n    esac\n    case \"{{rmfloor}}\" in\n        ''|*[!0-9]*) echo \"a11y-e2e: rmfloor '{{rmfloor}}' is not a non-negative integer\" >&2; exit 64;;\n    esac\n    # --- Half 1: the a11y eval roster, pinned BY NAME. A deleted or renamed\n    # eval makes import() throw, which set -e turns into a non-zero exit.\n    # `node evals/<x>.eval.mjs` alone exits 0 VACUOUSLY (these three carry no\n    # main guard, by design: a main guard truncates run.mjs mid-loop at exit 0),\n    # so the default export must be imported and called.\n    a11y_eval_check() {\n        node -e \"import(process.argv[1]).then(m => m.default()).then(r => { if (!r.pass) { console.error('a11y eval FAIL: ' + r.name + ' — ' + r.detail); process.exit(1) } const m = /teeth=(\\\\d+)\\\\/(\\\\d+)/.exec(String(r.detail)); if (m === null) { console.error('a11y eval reports NO teeth tally: ' + r.name + ' — an eval that runs no inline fixtures proves nothing, and a body gutted to a bare pass:true looks identical to a real one'); process.exit(1) } if (m[1] !== m[2] || Number(m[1]) < 1) { console.error('a11y eval teeth uneven or empty: ' + r.name + ' — ' + m[0]); process.exit(1) } console.log('  teeth ' + m[0]) })\" -- \"$1\"\n        echo \"a11y eval OK: $1\"\n    }\n    a11y_eval_check ./evals/overlay-a11y-manifest.eval.mjs\n    a11y_eval_check ./evals/a11y-static-shell.eval.mjs\n    a11y_eval_check ./evals/reduced-motion-purity.eval.mjs\n    # --- Half 2: floor the a11y unit tier. Delete the stale report first: a\n    # leftover report from a previous run would be read as this run's result if\n    # vitest died before writing (measured shape).\n    rm -f /tmp/a11y-e2e-vitest.json\n    cd client && npx vitest run --reporter=json --outputFile=/tmp/a11y-e2e-vitest.json \\\n        src/ui/overlayA11yWiring.test.ts \\\n        src/ui/overlayA11y.test.ts \\\n        src/ui/focusTrap.test.ts \\\n        src/ui/liveRegion.test.ts \\\n        src/ui/announcements.test.ts \\\n        src/ui/a11yCopy.test.ts \\\n        src/main.a11yFocus.test.ts \\\n        src/render/motionPreference.test.ts\n    cd ..\n    node -e \"const fs = require('node:fs'); let j; try { j = JSON.parse(fs.readFileSync('/tmp/a11y-e2e-vitest.json', 'utf8')) } catch (e) { console.error('a11y-e2e: vitest wrote no readable JSON report — ' + e.message); process.exit(1) } const floor = Number(process.argv[1]); const files = j.testResults.length; const total = j.numTotalTests; if (files !== 8) { console.error('a11y-e2e: ' + files + ' spec file(s) reported, expected 8 — an a11y spec file was deleted or renamed'); process.exit(1) } if (j.numFailedTests !== 0 || j.numPendingTests !== 0 || j.numTodoTests !== 0) { console.error('a11y-e2e: failed=' + j.numFailedTests + ' pending=' + j.numPendingTests + ' todo=' + j.numTodoTests + ' — a skipped a11y test is a silently ungated one'); process.exit(1) } if (total < floor) { console.error('a11y-e2e: a11y unit tier reported ' + total + ' test(s) across ' + files + ' file(s) — floor is ' + floor); process.exit(1) } console.log('A11Y-NIGHTLY OK evals=3/3 files=' + files + ' tests=' + total + ' floor=' + floor + ' f=0 pend=0 todo=0')\" -- \"{{floor}}\"\n    # --- Half 3: the axe-core + real-browser tier. Same stale-report discipline as\n    # half 2 — a leftover report from a previous run would be read as this run's\n    # result if playwright died before writing. The floor is asserted from the\n    # machine-readable report and never from console text: a MISSING spec file makes\n    # playwright report zero tests and exit 0, the same silent-zero shape vitest has.\n    rm -f /tmp/a11y-e2e-axe.json\n    cd client && PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/a11y-e2e-axe.json \\\n        npx playwright test e2e/a11y.spec.ts --reporter=json\n    cd ..\n    node -e \"const fs = require('node:fs'); let j; try { j = JSON.parse(fs.readFileSync('/tmp/a11y-e2e-axe.json', 'utf8')) } catch (e) { console.error('a11y-e2e: playwright wrote no readable JSON report — ' + e.message); process.exit(1) } const floor = Number(process.argv[1]); const s = j.stats; if (s === undefined) { console.error('a11y-e2e: playwright report carries no stats block'); process.exit(1) } if (s.unexpected !== 0 || s.flaky !== 0 || s.skipped !== 0) { console.error('a11y-e2e: axe tier unexpected=' + s.unexpected + ' flaky=' + s.flaky + ' skipped=' + s.skipped + ' — a skipped or flaky a11y test is a silently ungated one'); process.exit(1) } if (s.expected < floor) { console.error('a11y-e2e: axe tier reported ' + s.expected + ' passing test(s) — floor is ' + floor + '; a MISSING spec file reports zero and exits 0'); process.exit(1) } console.log('A11Y-AXE OK tests=' + s.expected + ' floor=' + floor + ' unexpected=0 flaky=0 skipped=0')\" -- \"{{axefloor}}\"\n    # --- Half 4: the reduced-motion browser tier (rb-20, ADR-0219). Same stale-\n    # report discipline as halves 2 and 3, and its OWN report path: reusing half\n    # 3's would clobber the axe evidence and a red in whichever tier ran second\n    # would be read as belonging to whichever ran first. Both paths are listed in\n    # nightly.yml's failure-evidence artifact.\n    #\n    # `--project=reduced-motion` is LOAD-BEARING. client/playwright.config.ts now\n    # declares two projects, and an invocation naming none runs BOTH -- i.e. all\n    # 21 spec files, with a browser and a full world, instead of this project's\n    # two tests.\n    #\n    # ACCURACY NOTE -- this deliberately does NOT inherit half 3's rationale\n    # above, which is stale. MEASURED on the pinned @playwright/test 1.61.1: a\n    # MISSING spec file, an EMPTY spec file and a --project naming no project ALL\n    # exit 1 with \"No tests found\", so `set -euo pipefail` kills this recipe\n    # before any floor check could run. The shape that really does report\n    # expected=0 and exit 0 is a wholly `test.describe.skip`-ed spec file -- and\n    # the `s.skipped !== 0` clause below is what catches it. The floor is still\n    # read from the machine-readable report and never from console text.\n    rm -f /tmp/a11y-e2e-rm.json\n    cd client && PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/a11y-e2e-rm.json \\\n        npx playwright test --project=reduced-motion --reporter=json\n    cd ..\n    node -e \"const fs = require('node:fs'); let j; try { j = JSON.parse(fs.readFileSync('/tmp/a11y-e2e-rm.json', 'utf8')) } catch (e) { console.error('a11y-e2e: playwright wrote no readable JSON report for the reduced-motion tier — ' + e.message); process.exit(1) } const floor = Number(process.argv[1]); const s = j.stats; if (s === undefined) { console.error('a11y-e2e: reduced-motion report carries no stats block'); process.exit(1) } if (s.unexpected !== 0 || s.flaky !== 0 || s.skipped !== 0) { console.error('a11y-e2e: reduced-motion tier unexpected=' + s.unexpected + ' flaky=' + s.flaky + ' skipped=' + s.skipped + ' — a wholly describe.skip-ed spec file reports expected=0 and exits 0, and a skipped or flaky a11y test is a silently ungated one'); process.exit(1) } if (s.expected < floor) { console.error('a11y-e2e: reduced-motion tier reported ' + s.expected + ' passing test(s) — floor is ' + floor); process.exit(1) } console.log('A11Y-RM OK tests=' + s.expected + ' floor=' + floor + ' unexpected=0 flaky=0 skipped=0')\" -- \"{{rmfloor}}\"\n    echo \"DEFERRED: A11Y-32 / A11Y-33 are MANUAL and are NEVER CI-green — docs/a11y-manual-protocol.md\"\n";

// The raw region for `recipeName`: its header line plus every following line that
// is blank or indented, with trailing blank lines dropped. Comments are KEPT.
function extractRawRecipeRegion(text, recipeName) {
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${recipeName}:`) || lines[i].startsWith(`${recipeName} `)) {
      start = i;
      break;
    }
  }
  if (start === -1) return '';
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.length > 0 && l[0] !== ' ' && l[0] !== '\t') break;
    end++;
  }
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  return `${lines.slice(start, end).join('\n')}\n`;
}

export function a11yRecipeBodyIsPinned(justfileText) {
  const region = extractRawRecipeRegion(justfileText, 'a11y-e2e');
  if (region === '') {
    return { ok: false, reason: 'justfile declares no a11y-e2e recipe at all' };
  }
  if (region !== A11Y_E2E_RECIPE_REGION) {
    return {
      ok: false,
      reason:
        'the justfile a11y-e2e recipe region does not match A11Y_E2E_RECIPE_REGION byte for byte. ' +
        'A substring check cannot see an `exit 0` planted above a byte-identical body (red-team ' +
        'proved that exact bypass), so this gate pins the region verbatim. If you changed the ' +
        'recipe deliberately, update A11Y_E2E_RECIPE_REGION in evals/ci-gate-wiring.eval.mjs in ' +
        'the SAME commit and say why in the message.',
    };
  }
  return { ok: true, reason: 'the a11y-e2e recipe region matches its verbatim pin' };
}

// ---------------------------------------------------------------------------
// rb-20 (residual R-m23-s11-X11), RM-4. Half 4 of `just a11y-e2e`: the new
// reduced-motion browser tier, fail-closed the same way halves 2 and 3 already
// are. A SEPARATE function from `a11yRecipeBodyIntact` / `a11yRecipeBodyIsPinned`
// so the EXISTING teeth (and the byte-exact `A11Y_E2E_RECIPE_REGION` pin) stay
// untouched — RM-5's own circularity note requires this: a bite-proof that
// regenerates the region pin for every recipe mutant must show the REJECTION
// came from a substring/structural tooth like this one, never from the pin
// alone (the pin necessarily agrees with whatever it was legitimately
// regenerated from).
// ---------------------------------------------------------------------------
const RM_HALF4_PROJECT_FLAG = '--project=reduced-motion';
// ADR-0219: "nightly.yml's failure-evidence artifact gains half 4's report
// path". Reusing half 3's path would clobber its evidence. If the real
// implementation legitimately picks a different literal, update this constant
// in the SAME commit — the house idiom this file already uses for every other
// moving pin. Read by a11yNightlyJobIsWired too, which asserts the nightly
// artifact `path:` list carries it.
const A11Y_HALF4_REPORT = '/tmp/a11y-e2e-rm.json';

// The justfile line index of the `a11y-e2e` recipe HEADER — a line at column 0
// beginning `a11y-e2e:` or `a11y-e2e ` — or -1 if there is not EXACTLY one.
// Deliberately NOT `justfileText.indexOf('a11y-e2e ')`: that first hit lands in
// a PROSE COMMENT ~10 lines above the real header ("The nightly a11y-e2e job
// provisions both..."), so every forward search anchored on it silently starts
// in the wrong place, and a second planted mention would move it again.
function a11yRecipeHeaderLines(justfileText) {
  const lines = justfileText.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.startsWith('a11y-e2e:') || l.startsWith('a11y-e2e ')) out.push(i);
  }
  return out;
}

// True when `text` reads `token` and IMMEDIATELY COMPARES it with one of `ops`.
// Presence of the bare token is NOT enough, and the difference is not academic —
// MEASURED against the real recipe, both times:
//   * deleting `if (s.expected < floor)` leaves
//     `console.log('... tests=' + s.expected)` behind, so a substring test for
//     `.expected` accepts a half 4 that reports its test count and floors
//     nothing;
//   * deleting `|| s.skipped !== 0` from the guard leaves
//     `console.error('... skipped=' + s.skipped + ...)` behind, so a substring
//     test for `skipped` accepts a half 4 that PRINTS the skip count in its
//     failure message while never branching on it.
// Only fail-closed operators are admitted: `s.skipped === 0` is the inverted
// guard, not a weaker one. Character scan, no regex literal (this repo has a
// measured case of a regex literal silently blinding a comment stripper).
function readsAndComparesToken(text, token, ops) {
  let from = 0;
  for (;;) {
    const at = text.indexOf(token, from);
    if (at === -1) return false;
    const rest = text.slice(at + token.length).trimStart();
    if (ops.some((op) => rest.startsWith(op))) return true;
    from = at + 1;
  }
}

function hasFloorComparison(text) {
  return readsAndComparesToken(text, '.expected', ['<']);
}

function hasSkippedGuard(text) {
  return readsAndComparesToken(text, '.skipped', ['!==', '!=', '>']);
}

export function a11yHalf4IsFailClosed(justfileText) {
  const body = extractRecipeBodyLocal(justfileText, 'a11y-e2e');
  if (!body) {
    return { ok: false, reason: 'justfile a11y-e2e: recipe body is empty or absent' };
  }

  if (body.indexOf(RM_HALF4_PROJECT_FLAG) === -1) {
    return {
      ok: false,
      reason:
        `justfile a11y-e2e: body never names '${RM_HALF4_PROJECT_FLAG}' — half 4 (rb-20, RM-4) is ` +
        'either absent, or would run every e2e spec rather than the reduced-motion project alone',
    };
  }

  if (body.indexOf(A11Y_HALF4_REPORT) === -1) {
    return {
      ok: false,
      reason:
        `justfile a11y-e2e: body never writes to '${A11Y_HALF4_REPORT}' — half 4 must write its ` +
        "own JSON report and must never reuse half 3's report path, or one run clobbers the " +
        "other's evidence and a red in whichever ran second is read as belonging to whichever " +
        'ran first',
    };
  }
  // Non-vacuity: the path must be BOTH written (PLAYWRIGHT_JSON_OUTPUT_NAME=)
  // and READ BACK by a later floor assertion — one occurrence alone is a
  // report nobody looks at.
  const occurrences = countOccurrences(body, A11Y_HALF4_REPORT);
  if (occurrences < 2) {
    return {
      ok: false,
      reason:
        `justfile a11y-e2e: '${A11Y_HALF4_REPORT}' appears only ${occurrences} time(s) — it must ` +
        'be both the playwright JSON output target AND the path a later `node -e` reads back to ' +
        'assert the floor; one occurrence is a report nobody reads',
    };
  }

  // Everything from half 4's report path onward — scopes the remaining checks
  // to half 4 rather than accidentally matching half 2/3's unrelated text.
  const half4Tail = body.slice(body.indexOf(A11Y_HALF4_REPORT));

  if (half4Tail.indexOf('--reporter=json') === -1) {
    return {
      ok: false,
      reason:
        'justfile a11y-e2e: half 4 does not run playwright with `--reporter=json` — RM-5: with ' +
        'the JSON reporter swapped for console output, PLAYWRIGHT_JSON_OUTPUT_NAME names a file ' +
        'nothing writes, and the floor is then asserted from a report that does not exist',
    };
  }
  if (!hasFloorComparison(half4Tail)) {
    return {
      ok: false,
      reason:
        'justfile a11y-e2e: half 4 never COMPARES `.expected` against a floor — the floor must ' +
        'be asserted from the MACHINE-READABLE report, never from console text (a wholly ' +
        'describe.skip-ed spec reports zero tests and exits 0 — ADR-0219 D4). Note this is a ' +
        'comparison check, not a presence check: deleting the `if (s.expected < floor)` line ' +
        "leaves `console.log('... tests=' + s.expected)` behind, and a bare `.expected` " +
        'substring test would accept that.',
    };
  }
  // The DECLARED floor must actually reach the checker process. Without this a
  // half 4 could compare `.expected` against a hard-coded 0 while `rmfloor` sits
  // unused in the header, case-guarded and meaningless.
  if (half4Tail.indexOf('{{rmfloor}}') === -1) {
    return {
      ok: false,
      reason:
        'justfile a11y-e2e: half 4 never passes `{{rmfloor}}` to its floor checker — the ' +
        'declared parameter must be the value compared against, not decoration',
    };
  }
  if (!hasSkippedGuard(half4Tail)) {
    return {
      ok: false,
      reason:
        "justfile a11y-e2e: half 4's floor check never BRANCHES on `.skipped` — a wholly " +
        "`test.describe.skip`'d reduced-motion spec reports `expected: 0` and exits 0 (ADR-0219 " +
        "D4's measured vacuity — distinct from half 3's stale rationale about missing files, " +
        'which actually exits 1 on 1.61.1), and only a `skipped !== 0` guard catches it. Note ' +
        'this is a COMPARISON check: merely PRINTING the skip count in a failure message ' +
        'satisfies a substring test for `skipped` while branching on nothing.',
    };
  }

  // ADR-0183 D7 / halves 2 and 3's precedent: the new floor PARAMETER must be
  // case-guarded as a non-negative integer BEFORE the run, or `Number('')` is
  // `0` and `Number('abc')` is `NaN` — `expected < NaN` is `false` — and a
  // malformed floor silently passes.
  const headerLines = a11yRecipeHeaderLines(justfileText);
  if (headerLines.length !== 1) {
    return {
      ok: false,
      reason: `justfile declares ${headerLines.length} \`a11y-e2e\` recipe header line(s) at column 0 — exactly one is required, or which header carries the floor parameters is ambiguous`,
    };
  }
  const headerLine = justfileText.split('\n')[headerLines[0]];
  if (headerLine.indexOf('rmfloor=') === -1) {
    return {
      ok: false,
      reason:
        'justfile a11y-e2e: recipe header declares no `rmfloor=` parameter — RM-4 requires the ' +
        'floor be a named, defaulted recipe parameter like `floor`/`axefloor`, not a literal ' +
        'baked into the body',
    };
  }
  if (body.indexOf('{{rmfloor}}') === -1) {
    return {
      ok: false,
      reason:
        'justfile a11y-e2e: body never references `{{rmfloor}}` — the declared parameter is unused',
    };
  }
  // ANCHORED ON THE CASE HEADER, not on the first `{{rmfloor}}` occurrence —
  // that occurrence IS the case header itself (`case "{{rmfloor}}" in`), and
  // the guard shape (`''|*[!0-9]*)`) necessarily comes AFTER it, never before.
  // COUNTED, not first-hit: two `case "{{rmfloor}}" in` headers would let a
  // decoy guard satisfy the window scan while the real one is gutted.
  const rmfloorCaseHeader = 'case "{{rmfloor}}" in';
  const caseHeaders = countOccurrences(body, rmfloorCaseHeader);
  if (caseHeaders === 0) {
    return {
      ok: false,
      reason:
        'justfile a11y-e2e: no `case "{{rmfloor}}" in` guard header exists — ADR-0183 D7: ' +
        "`Number('')` is 0 and `Number('abc')` is NaN, and `expected < NaN` is `false`, so an " +
        'empty or non-numeric rmfloor silently prints OK on a zero-test report',
    };
  }
  if (caseHeaders > 1) {
    return {
      ok: false,
      reason: `justfile a11y-e2e: ${caseHeaders} \`case "{{rmfloor}}" in\` guard headers exist — exactly one is required, or a decoy guard can satisfy this check while the real one is gutted`,
    };
  }
  const caseHeaderIdx = body.indexOf(rmfloorCaseHeader);
  const caseGuardShape = "''|*[!0-9]*)";
  const caseGuardWindow = body.slice(caseHeaderIdx, caseHeaderIdx + 300);
  if (caseGuardWindow.indexOf(caseGuardShape) === -1 || caseGuardWindow.indexOf('esac') === -1) {
    return {
      ok: false,
      reason:
        'justfile a11y-e2e: `case "{{rmfloor}}" in` is declared but does not carry the ' +
        "`''|*[!0-9]*)` non-negative-integer guard shape (closed by `esac`) within 300 " +
        'characters of the header — ADR-0183 D7',
    };
  }

  return {
    ok: true,
    reason:
      `justfile a11y-e2e: half 4 runs '${RM_HALF4_PROJECT_FLAG}', writes and reads back its own ` +
      `report at '${A11Y_HALF4_REPORT}', asserts its floor from that report with a skipped ` +
      'guard, and case-guards `rmfloor` as a non-negative integer before the run',
  };
}

// ---------------------------------------------------------------------------
// rb-19, spec §5.7 deliverable (3), stated as a NEGATIVE and therefore easy to
// leave unenforced — which is exactly what happened: red-team EXECUTED the
// promotion (append `a11y-e2e` to the justfile's `ci:` dependency line and add a
// `- run: just a11y-e2e` step to ci.yml's ci job) and the ENTIRE eval suite stayed
// green, because every other check here asks whether the gate is wired, never
// whether it is wired in the WRONG place.
//
// Three clauses, because there are three doors into the hermetic gate:
//   1. REQUIRED_JUST_STEPS naming it — this file's own roster.
//   2. the justfile `ci:` recipe depending on it, directly or transitively.
//   3. ci.yml carrying a `- run: just a11y-e2e` step, which needs no justfile edit
//      at all.
// Closing one or two of these would be theatre; a browser and a live server in the
// fast hermetic loop is the thing ADR-0043 forbids, however it gets there.
//
// The `ci:` dependency walk is TRANSITIVE on purpose: `ci: … coverage` where
// `coverage: a11y-e2e` puts it in the gate without `ci:` naming it.
export function a11yStaysNightlyOnly(justfileText, ciYaml) {
  if (REQUIRED_JUST_STEPS.indexOf(A11Y_RECIPE_NAME) !== -1) {
    return {
      ok: false,
      reason: `REQUIRED_JUST_STEPS names '${A11Y_RECIPE_NAME}' — spec §5.7 requires the axe tier stay OUT of the hermetic gate, and this roster is what ci.yml's ci job is checked against. Adding it here puts a browser and a live SpacetimeDB in the fast loop (ADR-0043).`,
    };
  }

  // The `ci:` recipe's dependency closure, read from the justfile's recipe headers.
  // Comment lines are dropped first: a `#` line mentioning the recipe is not a dep.
  const deps = new Map();
  for (const raw of justfileText.split('\n')) {
    if (raw.length === 0 || raw[0] === ' ' || raw[0] === '\t' || raw[0] === '#') continue;
    const colon = raw.indexOf(':');
    if (colon === -1 || raw.indexOf(':=') === colon) continue;
    const head = raw.slice(0, colon).trim();
    const nameOnly = head.indexOf(' ') === -1 ? head : head.slice(0, head.indexOf(' '));
    if (nameOnly.length === 0) continue;
    deps.set(
      nameOnly,
      raw
        .slice(colon + 1)
        .split('&&')[0]
        .split(' ')
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    );
  }
  const seen = new Set();
  const walk = (n) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const d of deps.get(n) ?? []) walk(d);
  };
  walk('ci');
  if (seen.has(A11Y_RECIPE_NAME)) {
    return {
      ok: false,
      reason: `the justfile 'ci:' recipe depends on '${A11Y_RECIPE_NAME}' (directly or transitively: ${[...seen].join(' -> ')}) — 'just ci' is the fast, hermetic, server-free gate, and the axe tier needs a browser and a published module`,
    };
  }

  // ci.yml needs no justfile edit at all: a bare step is enough.
  const stray = ciYaml
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .filter((l) => l.trim() === A11Y_NIGHTLY_STEP).length;
  if (stray !== 0) {
    return {
      ok: false,
      reason: `.github/workflows/ci.yml carries ${stray} '${A11Y_NIGHTLY_STEP}' step(s) — the per-PR workflow runs the axe SPEC through its own 'e2e' job by design (ADR-0218), but running the nightly RECIPE there drags the decay ratchet and its wasm dependency into the PR path`,
    };
  }

  return {
    ok: true,
    reason: `'${A11Y_RECIPE_NAME}' is absent from REQUIRED_JUST_STEPS, from the 'ci:' dependency closure, and from ci.yml — the axe tier stays nightly-only`,
  };
}

// The `path:` entries of every `actions/upload-artifact` step inside a job block.
// Handles BOTH YAML spellings — an inline scalar (`path: /tmp/x.json`) and a
// block literal (`path: |` followed by deeper-indented lines) — because a gate
// that only understands one of them is satisfied by rewriting into the other.
// `#` lines are dropped: a path that exists only as prose uploads nothing.
function artifactPathEntries(blockLines) {
  const entries = [];
  let uploads = 0;
  for (let i = 0; i < blockLines.length; i += 1) {
    const tr = blockLines[i].trim();
    if (tr.startsWith('#')) continue;
    if (tr.indexOf('uses: actions/upload-artifact') === -1) continue;
    uploads += 1;
    const stepIndent = blockLines[i].length - blockLines[i].trimStart().length;
    for (let j = i + 1; j < blockLines.length; j += 1) {
      const line = blockLines[j];
      const t = line.trim();
      if (t === '') continue;
      const indent = line.length - line.trimStart().length;
      // A sibling step, or any key at or above this step's indent, ends it.
      if (indent < stepIndent || (indent === stepIndent && t.startsWith('- '))) break;
      if (t.startsWith('#')) continue;
      if (!t.startsWith('path:')) continue;
      const inline = t.slice('path:'.length).trim();
      if (inline !== '' && inline !== '|' && inline !== '|-' && inline !== '>' && inline !== '>-') {
        entries.push(inline);
        break;
      }
      for (let k = j + 1; k < blockLines.length; k += 1) {
        const pl = blockLines[k];
        const pt = pl.trim();
        if (pt === '') continue;
        if (pl.length - pl.trimStart().length <= indent) break;
        if (pt.startsWith('#')) continue;
        entries.push(pt);
      }
      break;
    }
  }
  return { uploads, entries };
}

export function a11yNightlyJobIsWired(nightlyYaml) {
  // Last-key-wins guards FIRST: extractJobBlock only ever returns the FIRST
  // match, so a clean-first / neutered-second duplicate is invisible below.
  const dupJobs = checkNoDuplicateJobsKey(nightlyYaml);
  if (!dupJobs.ok) return dupJobs;
  const dupKey = checkNoDuplicateJobKey(nightlyYaml, 'a11y-e2e');
  if (!dupKey.ok) return dupKey;

  const block = extractJobBlock(nightlyYaml, 'a11y-e2e');
  if (!block.trim()) {
    return {
      ok: false,
      reason:
        'nightly.yml declares no `a11y-e2e:` job at 2-space indent — spec §5.7 requires the recipe be INVOKED by the nightly workflow, not merely to exist',
    };
  }

  // EXACTLY ONE non-comment line in the WHOLE FILE trims to the exact step. One
  // is the wiring; zero means it is absent, commented, or suffixed (`|| true`,
  // `; exit 0`) so it can no longer fail; two means a decoy copy is parked
  // somewhere and "which one is the gate" is ambiguous.
  let occurrences = 0;
  for (const line of nightlyYaml.split('\n')) {
    const tr = line.trim();
    if (tr.startsWith('#')) continue;
    if (tr === A11Y_NIGHTLY_STEP) occurrences++;
  }
  if (occurrences === 0) {
    return {
      ok: false,
      reason: `nightly.yml has no non-comment line whose trimmed form is exactly \`${A11Y_NIGHTLY_STEP}\` — a commented-out step, or one suffixed so it cannot fail (\`|| true\`, \`; exit 0\`), is not wiring`,
    };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      reason: `nightly.yml has ${occurrences} non-comment lines reading exactly \`${A11Y_NIGHTLY_STEP}\` — exactly one is required, or which step is the gate is ambiguous`,
    };
  }

  // ONE walk over the job block's pre-`steps:` keys. Job-level keys (runs-on,
  // needs, strategy, if, continue-on-error, env, ...) always precede `steps:`;
  // anything after it is step-level and is caught by the per-step range below.
  // Four things are checked here, and the last two exist because red-team
  // EXECUTED two "declared but never SCHEDULED" bypasses that every other check
  // in this predicate accepts, since none of them asks whether GitHub will ever
  // RUN the job: an empty `strategy.matrix` expands to ZERO job instances, and
  // `runs-on: [self-hosted, a-label-nothing-carries]` queues forever (any
  // eventual timeout reads as a generic cancellation, not an a11y signal). Both
  // are closed by NARROWING rather than by enumerating bad shapes: this job has
  // no legitimate use for a matrix, and exactly one legitimate runner.
  const A11Y_RUNS_ON = 'runs-on: ubuntu-latest';
  const blockLines = block.split('\n');
  let runsOnSeen = false;
  for (const line of blockLines) {
    const tr = line.trim();
    if (tr === 'steps:' || tr.startsWith('steps:')) break;
    if (tr.startsWith('#')) continue;
    if (tr.startsWith('if:')) {
      return {
        ok: false,
        reason:
          'nightly a11y-e2e job has a job-level if: condition — it can disable the entire job',
      };
    }
    if (tr.startsWith('continue-on-error:')) {
      const value = tr.slice('continue-on-error:'.length).trim();
      // WHITELIST, not isTruthyCoe's blacklist. Red-team EXECUTED two bypasses of
      // the blacklist: `${{ !cancelled() }}` and `${{ success() || true }}` are
      // both unconditionally true in every real run and both slipped through,
      // because isTruthyCoe only knows the literals true/yes/on/True and the exact
      // `${{ true }}`. An EXPRESSION whitelist is unclosable; a VALUE whitelist is
      // closable — this job has exactly one legitimate spelling, and "no key at
      // all" is the other. (isTruthyCoe is left byte-identical: it is shared with
      // ciStepsUnneutered, whose fixtures pin its current semantics. The same hole
      // exists there and is FLAGGED UPWARD rather than widened from this slice.)
      if (value !== 'false') {
        return {
          ok: false,
          reason: `nightly a11y-e2e job has job-level continue-on-error: ${value} — only the literal \`false\` (or no key at all) is admitted; an always-true expression is not a non-truthy value`,
        };
      }
    }
    if (tr.startsWith('strategy:') || tr.startsWith('matrix:')) {
      return {
        ok: false,
        reason: `nightly a11y-e2e job declares \`${tr}\` — a matrix strategy may expand to ZERO job instances, which declares the gate without ever running it`,
      };
    }
    if (tr.startsWith('runs-on:')) {
      runsOnSeen = true;
      if (tr !== A11Y_RUNS_ON) {
        return {
          ok: false,
          reason: `nightly a11y-e2e job declares \`${tr}\` — exactly \`${A11Y_RUNS_ON}\` is admitted; a job pointed at a label no runner carries is declared but never scheduled`,
        };
      }
    }
  }
  if (!runsOnSeen) {
    return {
      ok: false,
      reason: 'nightly a11y-e2e job declares no `runs-on:` — it cannot be scheduled at all',
    };
  }

  // Step-level neutering, scoped to the gate step's own range. Scoping matters:
  // a legitimate `if: always()` on a LATER upload-artifact step must not be
  // mistaken for a condition on the gate, and a shell `if curl …` inside a
  // `run: |` block is not a YAML `if:` key (its trimmed form is `if curl…`).
  const allLines = nightlyYaml.split('\n');
  const range = findStepRange(allLines, A11Y_NIGHTLY_STEP);
  if (range === null) {
    return {
      ok: false,
      reason: `nightly a11y-e2e job: could not resolve the step range for \`${A11Y_NIGHTLY_STEP}\``,
    };
  }
  for (let i = range[0]; i < range[1]; i++) {
    const tr = allLines[i].trim();
    if (tr.startsWith('#')) continue;
    if (tr.startsWith('if:')) {
      return {
        ok: false,
        reason: `nightly a11y-e2e gate step carries a step-level if: — \`${tr}\``,
      };
    }
    if (tr.startsWith('continue-on-error:')) {
      const value = tr.slice('continue-on-error:'.length).trim();
      // Same value whitelist as the job-level check above, same red-team reason.
      if (value !== 'false') {
        return {
          ok: false,
          reason: `nightly a11y-e2e gate step carries continue-on-error: ${value} — spec §5.7 requires a non-truthy value, and only the literal \`false\` is admitted; a soft-failing a11y gate is a toothless one`,
        };
      }
    }
  }

  // rb-20 / RM-4. The failure-evidence artifact's `path:` list is HARDCODED, so a
  // newly added half of `just a11y-e2e` is invisible to it until someone edits
  // the block — and a red in the new tier then ships with NOTHING to look at,
  // which is the exact gap that step's own comment says `if: always()` exists to
  // close. NOTHING gated this list before rb-20: the three nightly predicates
  // here gate the job's STEPS, and the verbatim job pin
  // (A11Y_E2E_NIGHTLY_JOB_BLOCK) goes quiet the moment it is legitimately
  // regenerated — which is precisely the moment a forgotten path slips through.
  // Scoped to the a11y-e2e job block.
  const artifact = artifactPathEntries(blockLines);
  if (artifact.uploads === 0) {
    return {
      ok: false,
      reason:
        'nightly a11y-e2e job declares no `actions/upload-artifact` step — every half of `just a11y-e2e` writes a JSON report, and a red that uploads none of them is a red nobody can triage',
    };
  }
  if (artifact.entries.length === 0) {
    return {
      ok: false,
      reason:
        "nightly a11y-e2e job's upload-artifact step declares an empty `path:` — an artifact that names no file is not evidence",
    };
  }
  if (artifact.entries.indexOf(A11Y_HALF4_REPORT) === -1) {
    return {
      ok: false,
      reason: `nightly a11y-e2e job's failure-evidence artifact does not list '${A11Y_HALF4_REPORT}' (it lists: ${artifact.entries.join(', ')}) — half 4 (rb-20, RM-4) writes that report, and without it a red in the reduced-motion tier uploads nothing`,
    };
  }

  return {
    ok: true,
    reason:
      "nightly.yml declares an a11y-e2e job that invokes `just a11y-e2e` exactly once, is schedulable (ubuntu-latest, no matrix), is unneutered at both the job and the step level, and uploads half 4's report as failure evidence",
  };
}

// ---------------------------------------------------------------------------
// rb-19 / B: a11ySpecUsesAxe(specText) → { ok, reason }
//
// This is the PAYLOAD gate. Every other check in this slice only proves that the
// recipe and the nightly job NAME a spec file; this one proves the named file
// actually scans something and actually asserts on what it found. Without it,
// `client/e2e/a11y.spec.ts` could be `test('a11y', () => {})` and the entire tier
// would be green ceremony.
//
// The comment stripper is load-bearing, not hygiene: EVERY token below is a plain
// English word that a determined (or merely lazy) author will also write in the
// file's own header comment, so a raw scan of the source cannot tell a scan from a
// description of a scan. Two measured traps in this repo shaped the implementation:
//   - a naive block-comment regex blanks an arbitrary span the moment the file
//     contains a regex literal such as /[/*]/ — with NO throw, a full false-green;
//   - a stray backtick silently terminates a template literal.
// So the stripper is a character scanner that tracks string, template-literal and
// regex-literal state, and it refuses to answer at all if it returned implausibly
// little text (a blanked file must read as "I could not scan", never as "token
// missing" and never as "all clear").
// ---------------------------------------------------------------------------

export const AXE_DEP_NAME = '@axe-core/playwright';

// Quoted forms on purpose. 'wcag2a' is a strict SUBSTRING of 'wcag2aa', so an
// unquoted membership test for the former is satisfied by the latter and the
// "tags present but wcag2aa missing" tooth could never bite.
// All five, not a representative pair: the reason string below says dropping a tag
// "shrinks the rule set without shrinking the claim", and that is only enforced if
// every tag the conformance claim rests on is named. Quoted forms on purpose —
// 'wcag2a' is a strict SUBSTRING of 'wcag2aa', and 'wcag21a' of 'wcag21aa', so
// unquoted membership tests for the shorter ones are satisfied by the longer.
const A11Y_AXE_REQUIRED_TAGS = ["'wcag2a'", "'wcag2aa'", "'wcag21a'", "'wcag21aa'", "'wcag22aa'"];

// The three page states the spec must drive, identified by their settled key
// drivers (rb-19 handoff): connected world chrome, help overlay via Shift+Slash,
// menu overlay via KeyM. Without these, a spec that scans ONE state passes every
// other clause here while covering a third of the surface. If the interaction
// genuinely changes, update this const in the SAME commit — house idiom.
const A11Y_AXE_STATE_KEYS = ['Shift+Slash', 'KeyM'];

// Identifier positions after which a `/` begins a REGEX rather than a division.
const REGEX_PRECEDING_KEYWORDS = [
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'do',
  'else',
  'case',
  'yield',
  'await',
];

// True iff a `/` at src[idx] starts a regex literal rather than a division.
//
// LATENT ASSUMPTION: the look-back walks RAW source, so a `/` on the line after a
// `//` comment that ends in an identifier is read as division. That direction is
// safe (we then copy the characters through verbatim); the unsafe direction —
// mistaking a division for a regex — cannot swallow a comment, because the regex
// scanner stops at the first unescaped `/` outside a character class.
function regexCanStartAt(src, idx) {
  let j = idx - 1;
  while (j >= 0 && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) {
    j--;
  }
  if (j < 0) return true;
  const prev = src[j];
  if ('(,=:[!&|?{};+-*%^~<>'.indexOf(prev) !== -1) return true;
  if (/[A-Za-z0-9_$]/.test(prev)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
    return REGEX_PRECEDING_KEYWORDS.indexOf(src.slice(k + 1, j + 1)) !== -1;
  }
  return false;
}

// Remove `//` and block comments from JS/TS source WITHOUT touching strings,
// template literals or regex literals. Character-scanned, never regex-replaced.
function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (i + 1 < n ? src[i + 1] : '');
          i += 2;
          continue;
        }
        out += src[i];
        const isClose = src[i] === quote;
        i++;
        if (isClose) break;
      }
      continue;
    }
    if (c === '/' && regexCanStartAt(src, i)) {
      out += c;
      i++;
      let inClass = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') {
          out += ch + (i + 1 < n ? src[i + 1] : '');
          i += 2;
          continue;
        }
        out += ch;
        i++;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '\n') break;
        else if (ch === '/' && !inClass) break;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Index just past the string / template literal that STARTS at src[i].
//
// Templates recurse through `${ ... }` rather than scanning to the next backtick.
// A non-recursive matcher desyncs the moment a template nests inside an
// interpolation (measured in this repo), and a desynced blanker leaves message prose
// visible as if it were code — which is precisely the hole this file closes.
function skipStringLike(src, i) {
  const n = src.length;
  const quote = src[i];
  let j = i + 1;
  if (quote !== '`') {
    while (j < n) {
      if (src[j] === '\\') {
        j += 2;
        continue;
      }
      if (src[j] === quote) return j + 1;
      j++;
    }
    return n;
  }
  while (j < n) {
    if (src[j] === '\\') {
      j += 2;
      continue;
    }
    if (src[j] === '`') return j + 1;
    if (src[j] === '$' && src[j + 1] === '{') {
      j += 2;
      let braces = 1;
      while (j < n && braces > 0) {
        const ch = src[j];
        if (ch === "'" || ch === '"' || ch === '`') {
          j = skipStringLike(src, j);
          continue;
        }
        if (ch === '{') braces++;
        else if (ch === '}') braces--;
        j++;
      }
      continue;
    }
    j++;
  }
  return n;
}

// `src` (already comment-stripped) with the CONTENT of every string and template
// literal removed — delimiters and newlines kept so nothing downstream is warped.
//
// This is the categorical half of the M3 fix. A failure message can say whatever it
// likes about violations; after this pass there is no text in it for a clause to
// find. Regex literals are copied through verbatim: their bodies are code, not prose,
// and blanking one could glue neighbouring tokens together.
//
// FAILURE DIRECTION, on purpose: if the scanner ever mis-tokenises, it blanks MORE
// than it should, which can only remove tokens and therefore only cause a false RED —
// loud and fixable. It cannot manufacture a false GREEN.
function blankStringLiterals(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = skipStringLike(src, i);
      out += c;
      for (let k = i; k < end; k++) {
        if (src[k] === '\n') out += '\n';
      }
      out += c;
      i = end;
      continue;
    }
    if (c === '/' && regexCanStartAt(src, i)) {
      out += c;
      i++;
      let inClass = false;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') {
          out += ch + (i + 1 < n ? src[i + 1] : '');
          i += 2;
          continue;
        }
        out += ch;
        i++;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '\n') break;
        else if (ch === '/' && !inClass) break;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Index of the `)` that closes a call whose `(` sits just before `start`, or -1.
function callCloseIndex(text, start) {
  let depth = 1;
  let i = start;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipStringLike(text, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// Source of the FIRST argument of a call whose `(` sits just before `start`.
// Depth-tracked, so the commas in `reduce((n, v) => n + v.nodes.length, 0)` and the
// arrow parameters in `map((v) => v.id)` are not mistaken for the argument separator.
function firstArgumentSource(text, start) {
  let depth = 1;
  let out = '';
  let i = start;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = skipStringLike(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      out += c;
      i++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return out;
      out += c;
      i++;
      continue;
    }
    if (c === ',' && depth === 1) return out;
    out += c;
    i++;
  }
  return null;
}

const IDENTIFIER_ONLY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Every `expect(...)` / `expect.soft(...)` in `code` as { subject, tail }:
//   subject — the source of the FIRST argument. In `expect(value, message)` the
//             asserted thing is argument ONE; argument two is prose. Pinning the
//             subject is what makes "the message mentions it" stop counting.
//   tail    — the matcher chain that follows the call, up to the statement end.
// Calls whose result is never used are DROPPED: a bare `expect(x);` invokes no
// matcher and asserts nothing, which is the same declaration-vs-invocation
// distinction the `.analyze()` clause already draws.
function expectSubjects(code) {
  const found = [];
  for (const opener of ['expect(', 'expect.soft(']) {
    let from = 0;
    while (from <= code.length) {
      const idx = code.indexOf(opener, from);
      if (idx === -1) break;
      from = idx + opener.length;
      // `expect` must be a whole word — never the tail of `myexpect(`.
      if (idx > 0 && /[A-Za-z0-9_$]/.test(code[idx - 1])) continue;
      const argStart = idx + opener.length;
      const subject = firstArgumentSource(code, argStart);
      if (subject === null) continue;
      const close = callCloseIndex(code, argStart);
      if (close === -1) continue;
      let k = close + 1;
      while (k < code.length && /\s/.test(code[k])) k++;
      if (code[k] !== '.') continue;
      const stop = code.indexOf(';', close);
      found.push({
        subject,
        tail: code.slice(close + 1, stop === -1 ? Math.min(close + 200, code.length) : stop),
      });
    }
  }
  return found;
}

// The first { subject, tail } whose ASSERTED VALUE mentions `token`, or null.
//
// ONE-HOP ALIAS EXPANSION is what keeps this from gating a naming convention:
// `const ids = results.incomplete.map(...); expect(ids).toEqual([])` asserts on
// `incomplete` just as surely as `expect(results.incomplete...)` does, and a gate
// that only accepted the second spelling would red the first time someone renamed a
// local. `code` is already string-blanked, so an alias initialiser cannot be
// satisfied by message prose either.
function assertionOn(code, subjects, token) {
  for (const entry of subjects) {
    if (entry.subject.indexOf(token) !== -1) return entry;
    const name = entry.subject.trim();
    if (!IDENTIFIER_ONLY.test(name)) continue;
    for (const kw of ['const ', 'let ', 'var ']) {
      const decl = `${kw}${name} =`;
      const at = code.indexOf(decl);
      if (at === -1) continue;
      const rhsStart = at + decl.length;
      const stop = code.indexOf(';', rhsStart);
      const rhs = code.slice(rhsStart, stop === -1 ? Math.min(rhsStart + 400, code.length) : stop);
      if (rhs.indexOf(token) !== -1) return entry;
    }
  }
  return null;
}

//

export function a11ySpecUsesAxe(specText) {
  if (typeof specText !== 'string' || specText.trim() === '') {
    return {
      ok: false,
      reason:
        'client/e2e/a11y.spec.ts is empty or unreadable — an absent axe spec is the rb-19 RED-before state and must read as a FAIL, never as a skip',
    };
  }

  const stripped = stripJsComments(specText);
  if (stripped.length < 200 || stripped.length * 5 < specText.length) {
    return {
      ok: false,
      reason: `a11y spec comment-stripper returned ${stripped.length} of ${specText.length} raw bytes — either the spec is almost entirely comment (a hollow spec) or the stripper mis-tokenised it. Refusing to scan a blanked file: reporting "token missing" from blanked text would be a lie in one direction and reporting ok would be a lie in the other.`,
    };
  }

  // Quote-normalised copy. This repo's biome config prints single quotes, but a
  // pure token search must not turn on quote style; collapsing " into ' cannot
  // change any membership answer below.
  //
  // TWO VIEWS, and which clause may use which is load-bearing. `scan` keeps string
  // CONTENT, because the import specifier, the wcag tags and the state keys
  // legitimately live inside string literals and nowhere else. `code` removes it,
  // and only the three ASSERTION clauses may read `code` — that is what stops a
  // failure message from standing in for the thing it describes.
  const scan = stripped.split('"').join("'");
  const code = blankStringLiterals(stripped);
  const subjects = expectSubjects(code);

  if (scan.indexOf(AXE_DEP_NAME) === -1) {
    return {
      ok: false,
      reason: `a11y spec never mentions '${AXE_DEP_NAME}' outside comments — a spec that does not import AxeBuilder cannot be running an axe scan, however thoroughly its header comment describes one`,
    };
  }
  // Reason strings below are deliberately DISJOINT: each names only the thing its
  // own clause failed on. A reason that also names the neighbouring clauses' tokens
  // makes every reason-pinned tooth vacuous (the needle matches whichever clause
  // fired), which is the same failure mode as a gate needle hidden in its own
  // failure message.
  if (scan.indexOf('new AxeBuilder(') === -1) {
    return {
      ok: false,
      reason:
        "a11y spec never constructs 'new AxeBuilder(' — the axe import is present but unused, and an unused import is not a scan",
    };
  }
  if (scan.indexOf('.analyze()') === -1) {
    return {
      ok: false,
      reason:
        "a11y spec constructs AxeBuilder but never calls '.analyze()' — nothing is scanned until it runs. Declaration, capture and invocation are three different things and only the third one executes.",
    };
  }
  // M3. The predecessor clause asked whether the word `violations` sat within 200
  // characters of an `expect(` — and in the shipped spec it does TWICE, once as the
  // asserted value and once inside that same expect's failure message. Gutting the
  // value left the message, and the gate read clean. Proximity is not assertion.
  if (assertionOn(code, subjects, 'violations') === null) {
    return {
      ok: false,
      reason:
        "a11y spec never makes 'violations' the SUBJECT of an expect(...) — every surviving mention is in a comment, in a failure message, or in code nothing ever checks. A message that TALKS about violations is not an assertion about them: the scan runs, the message is composed, and nothing is verified.",
    };
  }
  // Same hole as M3, one clause over: two independent existence checks, arbitrarily
  // far apart, either satisfiable from a message string ("...only ${results.passes
  // .length} passing rule(s)..." is exactly such a message in the shipped spec).
  const passesAssertion = assertionOn(code, subjects, 'passes');
  if (passesAssertion === null) {
    return {
      ok: false,
      reason:
        'a11y spec has no NON-VACUITY FLOOR: nothing named passes is ever the SUBJECT of an expect(...). A page that failed to boot reports zero findings, which the emptiness check alone cannot tell apart from a perfectly clean one — the measured false-green signature of this kind of tier. A count quoted inside a failure message is not an assertion about it.',
    };
  }
  // The matcher IS pinned here and nowhere else in this function, because "a floor"
  // is a CLOSED semantic — a lower bound — where an open matcher vocabulary is not.
  // Two spellings are admitted: a toBeGreaterThan{,OrEqual} matcher on THIS
  // assertion, or a comparison inside the subject itself
  // (`expect(results.passes.length >= FLOOR).toBe(true)`).
  if (
    passesAssertion.tail.indexOf('toBeGreaterThan') === -1 &&
    passesAssertion.subject.indexOf('>') === -1
  ) {
    return {
      ok: false,
      reason:
        'a11y spec makes passes the subject of an expect(...) but never bounds it from BELOW — no toBeGreaterThan / toBeGreaterThanOrEqual on that assertion and no comparison in the subject. An unbounded assertion on passes does not distinguish a rendered page from a blank one, which is the only thing this floor exists to do.',
    };
  }
  if (scan.indexOf('withTags') === -1) {
    return {
      ok: false,
      reason:
        "a11y spec never calls '.withTags(' — an unfiltered axe run silently includes best-practice rules (deliberately excluded here), so the rule set it actually enforces is unknown",
    };
  }
  for (const tag of A11Y_AXE_REQUIRED_TAGS) {
    if (scan.indexOf(tag) === -1) {
      return {
        ok: false,
        reason: `a11y spec's axe tag list never contains ${tag} — the conformance target is WCAG 2.x A + AA; dropping a tag shrinks the rule set without shrinking the claim`,
      };
    }
  }
  // Bare presence was the weakest of the three: the shipped spec names this token
  // inside TWO failure-message templates, so the clause was satisfied by prose alone.
  if (assertionOn(code, subjects, 'incomplete') === null) {
    return {
      ok: false,
      reason:
        "a11y spec never makes 'incomplete' the SUBJECT of an expect(...) — axe reports checks it could not decide as a category of its own, so a rule that degrades from a clean result to needs-review vanishes from the report entirely unless the ceiling is asserted (the open residual rb-14 — no contrast oracle has shipped, so this ceiling has no upstream to agree with; shrink-only). Naming it in a message string is not asserting on it.",
    };
  }
  for (const key of A11Y_AXE_STATE_KEYS) {
    if (scan.indexOf(key) === -1) {
      return {
        ok: false,
        reason: `a11y spec never drives the '${key}' page state — the tier is specified over THREE page states, and a spec that scans fewer satisfies every other clause here while covering a fraction of the surface. If the interaction changed deliberately, update A11Y_AXE_STATE_KEYS in the SAME commit.`,
      };
    }
  }

  return {
    ok: true,
    reason:
      'client/e2e/a11y.spec.ts imports @axe-core/playwright, constructs AxeBuilder, calls .analyze(), asserts violations, floors passes, pins the WCAG A/AA tags, bounds incomplete, and drives all three page states',
  };
}

// ---------------------------------------------------------------------------
// rb-19 / C: clientDeclaresAxeDep(pkgJsonText, lockText) → { ok, reason }
//
// The spec above cannot run at all if the dependency is not installable, and the
// three ways that happens are all invisible to a substring scan:
//   - declared under `dependencies` instead of `devDependencies` (ships a test
//     harness into the client bundle);
//   - pinned with a range (^ / ~ / * / x), so axe-core's rule set — and therefore
//     the measured floors this slice hardcodes — can change between two runs of
//     the SAME commit, turning a nightly red into an unreproducible one;
//   - present in package.json but absent from package-lock.json, which makes the
//     nightly job's `npm ci` step hard-error before the gate ever runs.
// JSON.parse, never indexOf: '@axe-core/playwright' sitting in a `description`
// string is not a declared dependency, and a substring scan cannot tell them apart.
// ---------------------------------------------------------------------------

const AXE_LOCK_KEY = 'node_modules/@axe-core/playwright';
const EXACT_SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

// Own-property read that never inherits from Object.prototype and never returns a
// non-object (both sides of the own-property boundary matter — a prior slice in
// this repo pinned one side and shipped the other unguarded).
function readOwnObject(obj, key) {
  if (obj === null || typeof obj !== 'object') return {};
  if (!Object.hasOwn(obj, key)) return {};
  const value = obj[key];
  return value !== null && typeof value === 'object' ? value : {};
}

export function clientDeclaresAxeDep(pkgJsonText, lockText) {
  let pkg;
  try {
    pkg = JSON.parse(pkgJsonText);
  } catch (e) {
    return {
      ok: false,
      reason: `client/package.json is not parseable JSON — ${e.message}. This gate parses rather than substring-scans on purpose: '@axe-core/playwright' inside a description string is not a declared dependency.`,
    };
  }
  if (pkg === null || typeof pkg !== 'object') {
    return { ok: false, reason: 'client/package.json did not parse to an object' };
  }

  const dev = readOwnObject(pkg, 'devDependencies');
  const prod = readOwnObject(pkg, 'dependencies');
  const inDev = Object.hasOwn(dev, AXE_DEP_NAME);
  const inProd = Object.hasOwn(prod, AXE_DEP_NAME);

  // Checked BEFORE the devDependencies presence test so a both-places declaration
  // still rejects rather than passing on the dev half.
  if (inProd) {
    return {
      ok: false,
      reason: `client/package.json declares '${AXE_DEP_NAME}' as a runtime dependency — it is a test-only tool and belongs in devDependencies; a runtime declaration puts axe-core on the shipped dependency graph`,
    };
  }
  if (!inDev) {
    return {
      ok: false,
      reason: `client/package.json declares no '${AXE_DEP_NAME}' in devDependencies — client/e2e/a11y.spec.ts cannot import AxeBuilder and the nightly axe tier cannot run`,
    };
  }

  const spec = dev[AXE_DEP_NAME];
  if (typeof spec !== 'string' || !EXACT_SEMVER.test(spec)) {
    return {
      ok: false,
      reason: `client/package.json pins '${AXE_DEP_NAME}' at ${JSON.stringify(spec)} — an EXACT version is required (a whitelist, not a blacklist of ^ ~ * x). A floating range lets axe-core's rule set move under a hardcoded passes floor, so the same commit can be green today and red tomorrow for no code reason.`,
    };
  }

  if (typeof lockText !== 'string' || lockText.trim() === '') {
    return {
      ok: false,
      reason:
        'client/package-lock.json is empty or unreadable — the nightly a11y job installs with `npm ci`, which builds strictly from the lockfile',
    };
  }
  let lock = null;
  try {
    lock = JSON.parse(lockText);
  } catch {
    lock = null;
  }
  if (lock !== null && Object.hasOwn(lock, 'packages')) {
    const packages = readOwnObject(lock, 'packages');
    if (!Object.hasOwn(packages, AXE_LOCK_KEY)) {
      return {
        ok: false,
        reason: `client/package-lock.json has no '${AXE_LOCK_KEY}' entry — npm ci hard-errors when the lockfile disagrees with the manifest, so the nightly a11y job would die at "Install client deps" and the axe tier would never run`,
      };
    }
    const entry = readOwnObject(packages, AXE_LOCK_KEY);
    const locked = Object.hasOwn(entry, 'version') ? entry.version : undefined;
    if (locked !== spec) {
      return {
        ok: false,
        reason: `client/package-lock.json locks it at ${JSON.stringify(locked)} while client/package.json pins ${JSON.stringify(spec)} — npm ci refuses a lockfile that disagrees with the manifest`,
      };
    }
  } else if (lockText.indexOf(AXE_DEP_NAME) === -1) {
    return {
      ok: false,
      reason: `client/package-lock.json never mentions '${AXE_DEP_NAME}' — npm ci installs from the lockfile, so a manifest-only devDependency is not installed`,
    };
  }

  return {
    ok: true,
    reason: `client/package.json declares '${AXE_DEP_NAME}': '${spec}' as an EXACT devDependency and the lockfile carries the same version`,
  };
}

// ---------------------------------------------------------------------------
// rb-19 / D: A11Y_E2E_NIGHTLY_JOB_BLOCK + a11yNightlyJobIsPinned(nightlyYaml)
//
// Same house remedy as A11Y_E2E_RECIPE_REGION, and for a sharper reason. rb-19
// takes the nightly `a11y-e2e:` job from ONE pre-gate shell step to SIX (SpacetimeDB
// CLI install, version pin, start, wait, playwright install, npm ci). That is
// exactly the surface this repo has a MEASURED exploit class for: see the TEETH U1
// fixtures in evals/nightly-smoke-wiring.eval.mjs, where a step that appends a
// directory holding a `just` shim to $GITHUB_PATH shadows the real recipe while
// every token check — exact run-step text, no if:, no continue-on-error — reads
// perfectly clean. A token list structurally cannot see an INSERTED step. A
// verbatim pin can, and it is closable by construction: any edit to the region reds
// the gate, and the fix is to regenerate the constant in the SAME commit,
// deliberately.
//
// REGENERATE, NEVER HAND-TYPE. Any deliberate edit to the a11y-e2e job must be
// followed, in the SAME commit, by re-deriving this constant from the finished
// workflow. A one-character drift is indistinguishable from a typo by exit code:
//   node -e "import('./evals/e2e-desync-teeth.eval.mjs').then(m=>{const fs=require('node:fs');console.log(JSON.stringify(m.extractJobBlock(fs.readFileSync('.github/workflows/nightly.yml','utf8'),'a11y-e2e')))})"
// and paste the printed JSON string literal as the constant's value. Do NOT hand-type it.
// ---------------------------------------------------------------------------

export const A11Y_E2E_NIGHTLY_JOB_BLOCK =
  "  a11y-e2e:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v6 # v6\n      - uses: dtolnay/rust-toolchain@stable # stable\n        with: { targets: wasm32-unknown-unknown }\n      # Distinct prefix-key (v1-a11y) so this cache never collides with the\n      # mutation (v1-nightly) / mutation-server (v1-nightly-server) / smoke\n      # (v1-smoke) job caches, or ci.yml's v1-ci / v1-e2e.\n      - uses: Swatinem/rust-cache@v2 # v2\n        with: { prefix-key: v1-a11y }\n      - uses: jetli/wasm-pack-action@0d096b08b4e5a7de8c28de67e11e945404e9eefa # v0.4.0\n        with: { version: 'v0.15.0' }\n      - uses: actions/setup-node@v7 # v7\n        with:\n          node-version: '24.13.1'\n          cache: npm\n          cache-dependency-path: client/package-lock.json\n      - uses: extractions/setup-just@dd310ad5a97d8e7b41793f8ef055398d51ad4de6 # v2\n      # `npm ci` lives here rather than inside the recipe so a local\n      # `just a11y-e2e` never clobbers a developer's node_modules.\n      - name: Install client deps\n        run: cd client && npm ci\n      - name: Install Playwright chromium\n        run: cd client && npx playwright install --with-deps chromium\n      # rb-19: half 3 drives a real browser against a real client, and the client's\n      # playwright.config.ts globalSetup republishes the module — so this job needs\n      # the same SpacetimeDB provisioning ci.yml's `e2e` job and the\n      # `smoke-republish` job above carry. Same download-then-execute installer\n      # (fetch to a file, then run the file — never pipe the fetch into a shell,\n      # which semgrep's gha-curl-pipe-shell rule rejects), same 2.8.1 pin.\n      - name: Install SpacetimeDB CLI\n        # `--yes`: the installer prompts to confirm and aborts on a non-tty runner\n        # without it. The install also generates the identity keypair used to publish.\n        run: |\n          curl -sSf -o /tmp/spacetime-install.sh https://install.spacetimedb.com\n          sh /tmp/spacetime-install.sh --yes\n          echo \"$HOME/.local/bin\" >> \"$GITHUB_PATH\"\n      - name: Pin spacetime 2.8.1\n        run: |\n          spacetime version install 2.8.1\n          spacetime version use 2.8.1\n          spacetime --version\n      # Ephemeral in-memory instance on the client's default host/port.\n      - name: Start SpacetimeDB\n        run: nohup spacetime start --in-memory --listen-addr 127.0.0.1:3000 > /tmp/stdb-a11y.log 2>&1 &\n      - name: Wait for SpacetimeDB\n        run: |\n          for i in $(seq 1 60); do\n            if curl -s -o /dev/null http://127.0.0.1:3000/; then echo \"ready after ${i}s\"; exit 0; fi\n            sleep 1\n          done\n          echo \"spacetime did not become ready on :3000\" >&2\n          cat /tmp/stdb-a11y.log >&2 || true\n          exit 1\n      # Deliberately NO continue-on-error and NO if: — a soft-failing decay\n      # ratchet is a toothless one. Both are gated by\n      # evals/ci-gate-wiring.eval.mjs (a11yNightlyJobIsWired), which also pins\n      # this step to exactly one unsuffixed occurrence file-wide. `env:` comes\n      # AFTER `run:` on purpose: that check matches the step's trimmed line\n      # exactly, and a step whose first key is `env:` reads as zero occurrences.\n      # The db name is per-run isolated so it never collides with a concurrent\n      # nightly run or with the regular monster-realm dev/e2e database.\n      - run: just a11y-e2e\n        env:\n          STDB_SERVER: http://127.0.0.1:3000\n          VITE_STDB_URI: ws://127.0.0.1:3000\n          VITE_STDB_DB: monster-realm-a11y-${{ github.run_id }}\n          MR_E2E_PORT: '5292'\n      # ADR-0200 D7, same reasoning as the mutation jobs: `if: always()` is\n      # load-bearing, not hygiene. The GitHub default is `success()`, which\n      # uploads the vitest report only on the nights it is worthless and skips\n      # it on exactly the nights someone needs it to see WHICH spec vanished.\n      # `if-no-files-found: warn` is pinned explicitly as a ratchet against a\n      # later raise to `error`: at `error`, a job that died in `just wasm` before\n      # vitest ever ran would report a failing upload step instead of its REAL\n      # failure. The artifact name is distinct per job (upload-artifact v4\n      # hard-errors on a duplicate name within one run).\n      # A publish failure inside globalSetup, or a client that connects but never\n      # reaches ready(), reds this job with nothing to look at otherwise — the same\n      # reasoning smoke-republish's log dump carries.\n      - name: Dump SpacetimeDB logs on failure\n        if: failure()\n        run: cat /tmp/stdb-a11y.log || true\n      - name: Upload a11y vitest report (failure evidence)\n        if: always()\n        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4\n        with:\n          name: a11y-e2e-vitest-report\n          # ALL THREE halves' reports. Half 3 writes the axe one and half 4 (rb-20,\n          # ADR-0219) the reduced-motion one, and a nightly red IN either tier\n          # shipped no evidence at all until it was listed here — the exact gap\n          # `if: always()` exists to close for half 2. This list is hardcoded, so\n          # a new half is invisible to it unless someone edits this block;\n          # evals/ci-gate-wiring.eval.mjs (a11yNightlyJobIsWired) now asserts half\n          # 4's path is present, so \"added a tier, forgot the evidence\" reds.\n          path: |\n            /tmp/a11y-e2e-vitest.json\n            /tmp/a11y-e2e-axe.json\n            /tmp/a11y-e2e-rm.json\n          if-no-files-found: warn\n          retention-days: 14\n\n";

const RB19_PENDING_PIN = '<<<RB19-PENDING>>>';

// Parameterised so the proof-of-teeth fixtures can pin the BEHAVIOUR against a
// synthetic block they own, instead of against the real constant (whose final bytes
// the tester cannot know and whose value is a placeholder until the implementer
// regenerates it).
export function jobBlockMatchesPin(nightlyYaml, expectedBlock, pinName) {
  if (typeof expectedBlock !== 'string' || expectedBlock.indexOf(RB19_PENDING_PIN) !== -1) {
    return {
      ok: false,
      reason: `${pinName} is still the rb-19 placeholder — regenerate it mechanically from the finished .github/workflows/nightly.yml in the SAME commit (extractJobBlock(<nightly.yml>, 'a11y-e2e')) and paste the exact bytes. A pin nobody has filled in is not a pin.`,
    };
  }
  // Last-key-wins guards FIRST: extractJobBlock only ever returns the FIRST match,
  // so a clean-first / neutered-second duplicate is invisible to the comparison.
  const dupJobs = checkNoDuplicateJobsKey(nightlyYaml);
  if (!dupJobs.ok) return dupJobs;
  const dupKey = checkNoDuplicateJobKey(nightlyYaml, 'a11y-e2e');
  if (!dupKey.ok) return dupKey;

  const block = extractJobBlock(nightlyYaml, 'a11y-e2e');
  if (block.trim() === '') {
    return {
      ok: false,
      reason:
        'nightly.yml declares no a11y-e2e: job block at 2-space indent — there is nothing to pin, and an absent job is not a vacuous pass',
    };
  }
  if (block !== expectedBlock) {
    return {
      ok: false,
      reason: `the nightly a11y-e2e job block does not match ${pinName} byte for byte. rb-19 widens this job from one pre-gate shell step to six, and a $GITHUB_PATH shim step inserted anywhere among them shadows the real recipe while every token check still reads clean (measured: evals/nightly-smoke-wiring.eval.mjs TEETH U1). If you changed the job deliberately, regenerate ${pinName} in the SAME commit and say why in the message.`,
    };
  }
  return { ok: true, reason: `the nightly a11y-e2e job block matches ${pinName} byte for byte` };
}

export function a11yNightlyJobIsPinned(nightlyYaml) {
  return jobBlockMatchesPin(nightlyYaml, A11Y_E2E_NIGHTLY_JOB_BLOCK, 'A11Y_E2E_NIGHTLY_JOB_BLOCK');
}

// ---------------------------------------------------------------------------
// rb-19 / D-twin: a11yNightlyJobHasAxePrereqs(nightlyYaml) → { ok, reason }
//
// NOT redundant with the verbatim pin above, for the reason documented at the top
// of a11yRecipeBodyIntact: the pin says "nothing moved" and goes quiet the moment
// someone legitimately regenerates it; these token clauses are what still has to
// hold afterwards. Without them, a regenerated pin can silently bless a job that
// dropped the browser install or the server env and now runs `just a11y-e2e`
// against nothing.
// ---------------------------------------------------------------------------
const A11Y_NIGHTLY_AXE_PREREQ_TOKENS = [
  'playwright install',
  'chromium',
  'spacetime version install',
  'spacetime start',
  'MR_E2E_PORT',
  'STDB_SERVER',
  'VITE_STDB_URI',
  'VITE_STDB_DB',
];

export function a11yNightlyJobHasAxePrereqs(nightlyYaml) {
  const block = extractJobBlock(nightlyYaml, 'a11y-e2e');
  if (block.trim() === '') {
    return {
      ok: false,
      reason: 'nightly.yml declares no a11y-e2e: job block at 2-space indent',
    };
  }
  // Drop `#` comment lines before scanning: a job whose prose preamble merely
  // DESCRIBES starting a server has started nothing.
  const live = block
    .split('\n')
    .filter((ln) => !ln.trim().startsWith('#'))
    .join('\n');

  for (const token of A11Y_NIGHTLY_AXE_PREREQ_TOKENS) {
    if (live.indexOf(token) === -1) {
      return {
        ok: false,
        // Names ONLY the missing token. Listing the whole required set here would
        // make every reason contain every token, and each reason-pinned tooth
        // below would then match whichever clause happened to fire.
        reason: `nightly a11y-e2e job never names '${token}' on a non-comment line — Half 3 drives a real browser against a real server, and without it the axe spec cannot reach a connected world; it would scan a blank or disconnected page, which is exactly the false green the spec's own pass floor exists to catch`,
      };
    }
  }

  let occurrences = 0;
  for (const ln of live.split('\n')) {
    if (ln.trim() === A11Y_NIGHTLY_STEP) occurrences++;
  }
  if (occurrences !== 1) {
    return {
      ok: false,
      reason: `nightly a11y-e2e job block contains ${occurrences} non-comment lines trimming to exactly '${A11Y_NIGHTLY_STEP}' — exactly one is required; zero means it was commented out or suffixed so it can no longer fail, and the prereq steps would then run for nothing`,
    };
  }

  return {
    ok: true,
    reason: `nightly a11y-e2e job installs a browser and a SpacetimeDB, supplies the four e2e env vars, and still carries exactly one unsuffixed '${A11Y_NIGHTLY_STEP}'`,
  };
}

// ---------------------------------------------------------------------------
// Default export: proof-of-teeth fixtures first, then real-file checks.
// ---------------------------------------------------------------------------
export default async function ciGateWiringEval() {
  const name =
    'ci-gate-wiring (EARS 13.5a-1 + 13.5a-5: ci steps unneutered, justfile parity, recipe bodies, run.mjs, anchor)';

  // =========================================================================
  // PROOF-OF-TEETH FIXTURES
  // =========================================================================

  // --- T-good: healthy ci job with all 7 exact steps + the dependency-review
  //   step WITH its legit if: + continue-on-error: true + a shell `if curl` in
  //   a run: | block → ciStepsUnneutered OK.
  //   Kills: block-wide line scan that false-flags the dep-review step's if:/coe,
  //   and shell-if overreach that flags `if curl` inside run: |.
  const T_good = `name: CI
on:
  push: { branches: [master] }
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v4
      - name: Dependency review (SCA on PRs)
        if: github.event_name == 'pull_request'
        continue-on-error: true
        uses: actions/dependency-review-action@abc1234abc1234abc1234abc1234abc1234abc12 # v4
      - name: Wait for thing
        run: |
          for i in $(seq 1 10); do
            if curl -s http://example.com; then echo ok; exit 0; fi
            sleep 1
          done
      - run: just lint
      - run: just typecheck
      - run: just test
      - run: just eval
      - run: just wasm
      - run: just client-typecheck
      - run: just client-test
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v4
      - run: just e2e
`;
  {
    let r;
    try {
      r = ciStepsUnneutered(T_good);
    } catch (e) {
      return { name, pass: false, detail: `T-good: ciStepsUnneutered threw — ${e.message}` };
    }
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `T-good: ciStepsUnneutered should accept healthy ci job but rejected: ${r.reason}`,
      };
    }
  }

  // --- T-del: `run: just eval` step deleted → fail.
  //   Kills: impl that doesn't check all 7 required verbs.
  const T_del = T_good.replace('      - run: just eval\n', '');
  {
    let r;
    try {
      r = ciStepsUnneutered(T_del);
    } catch (e) {
      return { name, pass: false, detail: `T-del: ciStepsUnneutered threw — ${e.message}` };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: `T-del: ciStepsUnneutered should reject missing 'just eval' step but returned ok`,
      };
    }
  }

  // --- T-or-true: `- run: just test || true` → fail.
  //   Kills: impl that accepts suffixed run lines.
  const T_or_true = T_good.replace('      - run: just test\n', '      - run: just test || true\n');
  {
    let r;
    try {
      r = ciStepsUnneutered(T_or_true);
    } catch (e) {
      return { name, pass: false, detail: `T-or-true: ciStepsUnneutered threw — ${e.message}` };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: `T-or-true: ciStepsUnneutered should reject '- run: just test || true' but returned ok`,
      };
    }
  }

  // --- T-semicolon: `- run: just test; exit 0` → fail.
  //   Kills: impl that accepts semicolon-suffixed run lines.
  const T_semicolon = T_good.replace(
    '      - run: just test\n',
    '      - run: just test; exit 0\n',
  );
  {
    let r;
    try {
      r = ciStepsUnneutered(T_semicolon);
    } catch (e) {
      return { name, pass: false, detail: `T-semicolon: ciStepsUnneutered threw — ${e.message}` };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: `T-semicolon: ciStepsUnneutered should reject '- run: just test; exit 0' but returned ok`,
      };
    }
  }

  // --- T-comment: `run: just eval` present ONLY in a `#` comment, step absent → fail.
  //   Kills: impl that searches raw text including comments.
  const T_comment = `name: CI
on:
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: just lint
      - run: just typecheck
      - run: just test
      # - run: just eval   ← commented out, must not satisfy the gate
      - run: just wasm
      - run: just client-typecheck
      - run: just client-test
`;
  {
    let r;
    try {
      r = ciStepsUnneutered(T_comment);
    } catch (e) {
      return { name, pass: false, detail: `T-comment: ciStepsUnneutered threw — ${e.message}` };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: `T-comment: ciStepsUnneutered should reject a ci job where 'run: just eval' is only in a comment`,
      };
    }
  }

  // --- T-step-if: `- run: just test` step carrying step-level `if: false` → fail.
  //   Kills: impl that only checks job-level if: and misses step-level.
  const T_step_if = T_good.replace(
    '      - run: just test\n',
    '      - name: run tests\n        if: false\n        run: just test\n',
  );
  {
    let r;
    try {
      r = ciStepsUnneutered(T_step_if);
    } catch (e) {
      return { name, pass: false, detail: `T-step-if: ciStepsUnneutered threw — ${e.message}` };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: `T-step-if: ciStepsUnneutered should reject a 'just test' step with step-level if: false`,
      };
    }
  }

  // --- T-step-coe: same step carrying `continue-on-error: true` → fail.
  //   Kills: impl that only checks job-level continue-on-error.
  const T_step_coe = T_good.replace(
    '      - run: just test\n',
    '      - name: run tests\n        continue-on-error: true\n        run: just test\n',
  );
  {
    let r;
    try {
      r = ciStepsUnneutered(T_step_coe);
    } catch (e) {
      return { name, pass: false, detail: `T-step-coe: ciStepsUnneutered threw — ${e.message}` };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: `T-step-coe: ciStepsUnneutered should reject a 'just test' step with step-level continue-on-error: true`,
      };
    }
  }

  // --- T-job-if: ci JOB-level `if: false` → fail.
  //   Kills: impl that only checks step-level conditions.
  const T_job_if = `name: CI
on:
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    if: false
    steps:
      - run: just lint
      - run: just typecheck
      - run: just test
      - run: just eval
      - run: just wasm
      - run: just client-typecheck
      - run: just client-test
`;
  {
    let r;
    try {
      r = ciStepsUnneutered(T_job_if);
    } catch (e) {
      return { name, pass: false, detail: `T-job-if: ciStepsUnneutered threw — ${e.message}` };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: `T-job-if: ciStepsUnneutered should reject a ci job with job-level if: false`,
      };
    }
  }

  // --- T-multiline: `just test` only inside a `run: |` block behind a shell
  //   conditional (no exact `- run: just test` line) → fail.
  //   Kills: impl that does substring search on any `just test` occurrence.
  const T_multiline = `name: CI
on:
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: just lint
      - run: just typecheck
      - name: conditional tests
        run: |
          if [ "$RUN_TESTS" = "1" ]; then
            just test
          fi
      - run: just eval
      - run: just wasm
      - run: just client-typecheck
      - run: just client-test
`;
  {
    let r;
    try {
      r = ciStepsUnneutered(T_multiline);
    } catch (e) {
      return { name, pass: false, detail: `T-multiline: ciStepsUnneutered threw — ${e.message}` };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: `T-multiline: ciStepsUnneutered should reject 'just test' only inside a run: | shell conditional (no exact '- run: just test' line)`,
      };
    }
  }

  // --- T-nojob: workflow with no `ci:` job at all → fail (empty-block vacuous-pass tooth).
  //   Kills: impl that returns ok when the block is empty.
  const T_nojob = `name: CI
on:
  pull_request:
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - run: just e2e
`;
  {
    let r;
    try {
      r = ciStepsUnneutered(T_nojob);
    } catch (e) {
      return { name, pass: false, detail: `T-nojob: ciStepsUnneutered threw — ${e.message}` };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: `T-nojob: ciStepsUnneutered should reject a workflow with no ci: job (empty-block vacuous-pass tooth)`,
      };
    }
  }

  // --- T-dual-del (13.5a-5): justfile whose ci: line lacks `eval` + ci.yml
  //   lacking the eval step → ciStepsUnneutered still fails (hardcoded oracle)
  //   AND justfileCiDepsAppearInCi fails on the missing-from-justfile direction.
  //   Kills: impl that only checks one side of the dep parity.
  const T_dual_del_justfile = `ci: lint typecheck test security wasm client-typecheck client-test\n\ntest:\n    cargo nextest run --workspace\n    cargo test --doc --workspace\n\neval:\n    node evals/run.mjs\n\nclient-test:\n    cd client && npm test\n`;
  const T_dual_del_ci = T_del; // already has eval step removed
  {
    // ciStepsUnneutered still fails because REQUIRED_JUST_STEPS includes 'eval'
    let r;
    try {
      r = ciStepsUnneutered(T_dual_del_ci);
    } catch (e) {
      return { name, pass: false, detail: `T-dual-del (ciStepsUnneutered): threw — ${e.message}` };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: `T-dual-del: ciStepsUnneutered should still fail even when justfile also drops eval (hardcoded oracle)`,
      };
    }
  }
  {
    let r;
    try {
      r = justfileCiDepsAppearInCi(T_dual_del_justfile, T_del);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-dual-del (justfileCiDepsAppearInCi): threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: `T-dual-del: justfileCiDepsAppearInCi should fail when justfile ci: line is missing 'eval'`,
      };
    }
  }

  // --- T-sub: ci.yml fixture with `run: just security` absent but all four
  //   substitution markers present → justfileCiDepsAppearInCi OK.
  //   Remove one marker (semgrep) → fail.
  //   Kills: impl that requires an explicit `run: just security` step.
  const T_sub_justfile = `ci: lint typecheck test eval security wasm client-typecheck client-test\n\ntest:\n    cargo nextest run --workspace\n    cargo test --doc --workspace\n\neval:\n    node evals/run.mjs\n\nclient-test:\n    cd client && npm test\n`;
  const T_sub_ci_good = `name: CI
on:
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: gitleaks/gitleaks-action@abc1 # v2
      - run: just lint
      - run: just typecheck
      - run: just test
      - run: just eval
      - run: just wasm
      - run: just client-typecheck
      - run: just client-test
      - run: cargo audit --file Cargo.lock
      - run: pipx run semgrep scan --config auto --error
      - uses: anchore/sbom-action@abc2 # v0
`;
  {
    let r;
    try {
      r = justfileCiDepsAppearInCi(T_sub_justfile, T_sub_ci_good);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-sub good: justfileCiDepsAppearInCi threw — ${e.message}`,
      };
    }
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `T-sub good: justfileCiDepsAppearInCi should accept security via 4-marker substitution but rejected: ${r.reason}`,
      };
    }
  }
  // Remove semgrep marker → fail.
  const T_sub_ci_no_semgrep = T_sub_ci_good.replace(
    '      - run: pipx run semgrep scan --config auto --error\n',
    '',
  );
  {
    let r;
    try {
      r = justfileCiDepsAppearInCi(T_sub_justfile, T_sub_ci_no_semgrep);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-sub no-semgrep: justfileCiDepsAppearInCi threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: `T-sub no-semgrep: justfileCiDepsAppearInCi should fail when semgrep scan marker is absent`,
      };
    }
  }

  // --- T-recipe-gut: justfile fixture with `test:` body = `@echo ok` → fail;
  //   healthy justfile fixture → OK.
  //   Kills: impl that doesn't inspect recipe bodies.
  const T_recipe_gut_justfile = `ci: lint typecheck test eval security wasm client-typecheck client-test\n\ntest:\n    @echo ok\n\neval:\n    node evals/run.mjs\n\nclient-test:\n    cd client && npm test\n`;
  {
    let r;
    try {
      r = ciRecipeBodiesIntact(T_recipe_gut_justfile);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-recipe-gut: ciRecipeBodiesIntact threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: `T-recipe-gut: ciRecipeBodiesIntact should reject a test: body of '@echo ok'`,
      };
    }
  }
  const T_recipe_healthy_justfile = `ci: lint typecheck test eval security wasm client-typecheck client-test\n\ntest:\n    cargo nextest run --workspace\n    cargo test --doc --workspace\n\neval:\n    node evals/run.mjs\n\nclient-test:\n    cd client && npm test\n`;
  {
    let r;
    try {
      r = ciRecipeBodiesIntact(T_recipe_healthy_justfile);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-recipe-gut good: ciRecipeBodiesIntact threw — ${e.message}`,
      };
    }
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `T-recipe-gut good: ciRecipeBodiesIntact should accept a healthy justfile but rejected: ${r.reason}`,
      };
    }
  }

  // --- T-runmjs: gutted run.mjs text → fail; healthy-shaped text → OK.
  //   Kills: impl that doesn't check run.mjs structural invariants.
  const T_runmjs_gutted = `#!/usr/bin/env node\nprocess.exit(0);\n`;
  {
    let r;
    try {
      r = runMjsIsIntact(T_runmjs_gutted);
    } catch (e) {
      return { name, pass: false, detail: `T-runmjs gutted: runMjsIsIntact threw — ${e.message}` };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: `T-runmjs gutted: runMjsIsIntact should reject a gutted run.mjs (process.exit(0) only)`,
      };
    }
  }
  const T_runmjs_healthy = `#!/usr/bin/env node\nif (files.length === 0) { process.exit(1); }\nlet failed = 0;\ntry {\n  res = { pass: false };\n} catch (err) {\n  failed++;\n}\nprocess.exit(failed ? 1 : 0);\n`;
  {
    let r;
    try {
      r = runMjsIsIntact(T_runmjs_healthy);
    } catch (e) {
      return { name, pass: false, detail: `T-runmjs healthy: runMjsIsIntact threw — ${e.message}` };
    }
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `T-runmjs healthy: runMjsIsIntact should accept a healthy run.mjs but rejected: ${r.reason}`,
      };
    }
  }

  // --- T-anchor: lefthook text without the node line → fail; with it AND e2e-block
  //   step present → OK.
  //   Kills: impl that doesn't check both the lefthook and e2e job anchor.
  const T_lefthook_no_anchor = `pre-commit:\n  commands:\n    lint:\n      run: just lint\n`;
  const T_ci_with_anchor = `name: CI
on:
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: just lint
      - run: just typecheck
      - run: just test
      - run: just eval
      - run: just wasm
      - run: just client-typecheck
      - run: just client-test
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v4
      - run: node evals/ci-gate-wiring.eval.mjs
      - run: just e2e
`;
  {
    let r;
    try {
      r = anchorIsWired(T_lefthook_no_anchor, T_ci_with_anchor);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-anchor no-lefthook: anchorIsWired threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: `T-anchor no-lefthook: anchorIsWired should reject lefthook.yml without 'node evals/ci-gate-wiring.eval.mjs'`,
      };
    }
  }
  const T_lefthook_with_anchor = `pre-commit:\n  commands:\n    lint:\n      run: just lint\npre-push:\n  commands:\n    gate:\n      run: node evals/ci-gate-wiring.eval.mjs\n`;
  {
    let r;
    try {
      r = anchorIsWired(T_lefthook_with_anchor, T_ci_with_anchor);
    } catch (e) {
      return { name, pass: false, detail: `T-anchor good: anchorIsWired threw — ${e.message}` };
    }
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `T-anchor good: anchorIsWired should accept lefthook with node line AND e2e step but rejected: ${r.reason}`,
      };
    }
  }
  // e2e block has the anchor in lefthook but not in ci.yml e2e job → fail.
  const T_ci_no_anchor_step = T_ci_with_anchor.replace(
    '      - run: node evals/ci-gate-wiring.eval.mjs\n',
    '',
  );
  {
    let r;
    try {
      r = anchorIsWired(T_lefthook_with_anchor, T_ci_no_anchor_step);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-anchor no-e2e-step: anchorIsWired threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: `T-anchor no-e2e-step: anchorIsWired should reject when e2e job lacks '- run: node evals/ci-gate-wiring.eval.mjs' step`,
      };
    }
  }

  // --- T-dup-ci (F1): first `ci:` job is clean; second has `if: false` → REJECT.
  //   Kills: impl that only inspects the first block extracted by extractJobBlock.
  //   GitHub Actions last-key-wins — the runner executes the SECOND (neutered) block.
  const T_dup_ci = `name: CI
on:
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: just lint
      - run: just typecheck
      - run: just test
      - run: just eval
      - run: just wasm
      - run: just client-typecheck
      - run: just client-test
  ci:
    runs-on: ubuntu-latest
    if: false
    steps:
      - run: echo "neutered second ci block"
  e2e:
    runs-on: ubuntu-latest
    steps:
      - run: just e2e
`;
  {
    let r;
    try {
      r = ciStepsUnneutered(T_dup_ci);
    } catch (e) {
      return { name, pass: false, detail: `T-dup-ci: ciStepsUnneutered threw — ${e.message}` };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'T-dup-ci (F1): ciStepsUnneutered should reject a yaml with duplicate ci: job keys (first clean, second has if: false) — GitHub Actions last-key-wins executes the neutered block',
      };
    }
  }

  // --- T-dup-jobs (F9): duplicate top-level `jobs:` key → REJECT.
  //   Same class as F1 but at the top-level. The second jobs block (possibly
  //   neutered) is what the runner sees.
  const T_dup_jobs = `name: CI
on:
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: just lint
      - run: just typecheck
      - run: just test
      - run: just eval
      - run: just wasm
      - run: just client-typecheck
      - run: just client-test
jobs:
  ci:
    runs-on: ubuntu-latest
    if: false
    steps:
      - run: echo "neutered"
`;
  {
    let r;
    try {
      r = ciStepsUnneutered(T_dup_jobs);
    } catch (e) {
      return { name, pass: false, detail: `T-dup-jobs: ciStepsUnneutered threw — ${e.message}` };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'T-dup-jobs (F9): ciStepsUnneutered should reject a yaml with duplicate top-level `jobs:` keys (second block wins in GitHub Actions)',
      };
    }
  }

  // --- T-security-comment (F2): all four security markers present ONLY inside
  //   a single YAML comment line → REJECT.
  //   Kills: impl that uses raw indexOf (accepts markers in comments).
  const T_sub_justfile_sec = `ci: lint typecheck test eval security wasm client-typecheck client-test\n\ntest:\n    cargo nextest run --workspace\n    cargo test --doc --workspace\n\neval:\n    node evals/run.mjs\n\nclient-test:\n    cd client && npm test\n`;
  const T_security_comment_ci = `name: CI
on:
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      # Security note: gitleaks/gitleaks-action cargo audit semgrep scan anchore/sbom-action (all in one comment, no actual steps)
      - run: just lint
      - run: just typecheck
      - run: just test
      - run: just eval
      - run: just wasm
      - run: just client-typecheck
      - run: just client-test
`;
  {
    let r;
    try {
      r = justfileCiDepsAppearInCi(T_sub_justfile_sec, T_security_comment_ci);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-security-comment: justfileCiDepsAppearInCi threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'T-security-comment (F2): justfileCiDepsAppearInCi should reject when all four security markers appear only inside a YAML comment — raw indexOf bypass; must line-scan skipping #-prefixed lines',
      };
    }
  }

  // --- T-anchor-lefthook-comment (F3): anchor token only in a lefthook.yml comment → REJECT.
  //   Kills: the old raw-indexOf lefthook side of anchorIsWired.
  const T_lefthook_comment_anchor = `pre-commit:\n  commands:\n    lint:\n      run: just lint\n# - run: node evals/ci-gate-wiring.eval.mjs  (commented out, must not satisfy)\n`;
  {
    let r;
    try {
      r = anchorIsWired(T_lefthook_comment_anchor, T_ci_with_anchor);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-anchor-lefthook-comment: anchorIsWired threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          "T-anchor-lefthook-comment (F3): anchorIsWired should reject when 'node evals/ci-gate-wiring.eval.mjs' appears only in a lefthook.yml comment line — must line-scan skipping #-prefixed lines",
      };
    }
  }

  // ===========================================================================================
  // m23-s11 PROOF-OF-TEETH: a11yRecipeBodyIntact(justfileText) -> { ok, reason }
  //
  // Extracts the `a11y-e2e` recipe body with the EXISTING extractRecipeBodyLocal(text,
  // 'a11y-e2e') (already comment-stripping, already handling the `name param=` header form —
  // see the comment block above extractRecipeBodyLocal), then requires the body to be
  // non-empty AND contain: 'set -euo pipefail'; 'vitest run'; '--reporter=json';
  // 'overlayA11yWiring.test.ts'; and all three a11y eval filenames.
  // ===========================================================================================

  // --- T-a11y-recipe-absent: no `a11y-e2e:` recipe in the justfile at all → REJECT.
  //   Kills: an impl that treats an absent/empty extraction as vacuously OK.
  const T_a11y_recipe_absent_justfile = `lint:\n    echo lint\n\ntest:\n    echo test\n`;
  {
    let r;
    try {
      r = a11yRecipeBodyIntact(T_a11y_recipe_absent_justfile);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-recipe-absent: a11yRecipeBodyIntact threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-recipe-absent: a11yRecipeBodyIntact accepted a justfile with no a11y-e2e recipe at all',
      };
    }
  }

  // --- T-a11y-recipe-comment-only: recipe exists but its body is ONLY `#` comment lines
  //   (extractRecipeBodyLocal drops every `#`-prefixed line, so the extracted body is '') → REJECT.
  //   Kills: an impl that skips the non-empty-body guard.
  const T_a11y_recipe_comment_only_justfile = `lint:\n    echo lint\n\na11y-e2e:\n    # nothing but comments\n    # here too\n`;
  {
    let r;
    try {
      r = a11yRecipeBodyIntact(T_a11y_recipe_comment_only_justfile);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-recipe-comment-only: a11yRecipeBodyIntact threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-recipe-comment-only: a11yRecipeBodyIntact accepted a recipe whose body is only comment lines',
      };
    }
  }

  // --- T-a11y-recipe-echo-only: body = `echo "a11y ok"` (no real gating content) → REJECT.
  //   Kills: an impl that only checks non-empty, never the required tokens.
  const T_a11y_recipe_echo_only_justfile = `lint:\n    echo lint\n\na11y-e2e:\n    echo "a11y ok"\n`;
  {
    let r;
    try {
      r = a11yRecipeBodyIntact(T_a11y_recipe_echo_only_justfile);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-recipe-echo-only: a11yRecipeBodyIntact threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: 'T-a11y-recipe-echo-only: a11yRecipeBodyIntact accepted a body of echo "a11y ok"',
      };
    }
  }

  // --- Shared "full" body (all required tokens present, legitimately, uncommented) used as the
  //   base for three "drop one token" negative variants below via .replace(). Kept separate from
  //   the GOOD hostile fixture (which adds decoys/preamble/param-form on top).
  const A11Y_RECIPE_FULL_JUSTFILE = `lint:
    echo lint

a11y-e2e floor="169": wasm
    #!/usr/bin/env bash
    set -euo pipefail
    node -e "import('./evals/overlay-a11y-manifest.eval.mjs').then(m=>m.default()).then(r=>{if(!r.pass){throw new Error(r.detail)}})"
    node -e "import('./evals/a11y-static-shell.eval.mjs').then(m=>m.default()).then(r=>{if(!r.pass){throw new Error(r.detail)}})"
    node -e "import('./evals/reduced-motion-purity.eval.mjs').then(m=>m.default()).then(r=>{if(!r.pass){throw new Error(r.detail)}})"
    cd client && npx vitest run --reporter=json src/ui/overlayA11yWiring.test.ts

wasm:
    wasm-pack build client-wasm --target bundler
`;

  // --- T-a11y-recipe-no-set-euo: all vitest/eval tokens present, `set -euo pipefail` dropped →
  //   REJECT.
  //   Kills: an impl that never checks the fail-closed shell preamble.
  const T_a11y_recipe_no_setEuo = A11Y_RECIPE_FULL_JUSTFILE.replace('    set -euo pipefail\n', '');
  {
    let r;
    try {
      r = a11yRecipeBodyIntact(T_a11y_recipe_no_setEuo);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-recipe-no-set-euo: a11yRecipeBodyIntact threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          "T-a11y-recipe-no-set-euo: a11yRecipeBodyIntact accepted a body missing 'set -euo pipefail'",
      };
    }
  }

  // --- T-a11y-recipe-tokens-in-comment: every required token appears, verbatim, but ONLY inside
  //   a single `#` comment line inside the body (so extractRecipeBodyLocal's comment-stripping
  //   removes them from the returned body) → REJECT.
  //   Kills: an impl that bypasses extractRecipeBodyLocal and does a raw indexOf over the whole
  //   justfileText (or over the raw un-stripped recipe text), which would find these tokens.
  const T_a11y_recipe_tokens_in_comment_justfile = `lint:
    echo lint

a11y-e2e:
    #!/usr/bin/env bash
    set -euo pipefail
    # would run: vitest run --reporter=json src/ui/overlayA11yWiring.test.ts after evals/overlay-a11y-manifest.eval.mjs evals/a11y-static-shell.eval.mjs evals/reduced-motion-purity.eval.mjs (comment only, not real)
    echo "see above comment"
`;
  {
    let r;
    try {
      r = a11yRecipeBodyIntact(T_a11y_recipe_tokens_in_comment_justfile);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-recipe-tokens-in-comment: a11yRecipeBodyIntact threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-recipe-tokens-in-comment: a11yRecipeBodyIntact accepted a body whose required tokens appear only inside a # comment line',
      };
    }
  }

  // --- T-a11y-recipe-unrelated-spec: vitest call present, all a11y eval names present, but the
  //   spec file targeted is unrelated (overlayA11yWiring.test.ts substituted away) → REJECT.
  //   Kills: an impl that checks 'vitest run' + '--reporter=json' but never the target spec name.
  const T_a11y_recipe_unrelated_spec = A11Y_RECIPE_FULL_JUSTFILE.replace(
    'src/ui/overlayA11yWiring.test.ts',
    'src/ui/someOtherFile.test.ts',
  );
  {
    let r;
    try {
      r = a11yRecipeBodyIntact(T_a11y_recipe_unrelated_spec);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-recipe-unrelated-spec: a11yRecipeBodyIntact threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-recipe-unrelated-spec: a11yRecipeBodyIntact accepted a vitest call that never targets overlayA11yWiring.test.ts',
      };
    }
  }

  // --- T-a11y-recipe-drop-manifest / drop-static-shell / drop-reduced-motion: pin the vitest half
  //   intact, drop exactly ONE of the three a11y eval names independently → each must REJECT.
  //   Kills: an impl that checks only "at least one eval name" instead of all three independently.
  const T_a11y_recipe_drop_manifest = A11Y_RECIPE_FULL_JUSTFILE.replace(
    `    node -e "import('./evals/overlay-a11y-manifest.eval.mjs').then(m=>m.default()).then(r=>{if(!r.pass){throw new Error(r.detail)}})"\n`,
    '',
  );
  {
    let r;
    try {
      r = a11yRecipeBodyIntact(T_a11y_recipe_drop_manifest);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-recipe-drop-manifest: a11yRecipeBodyIntact threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-recipe-drop-manifest: a11yRecipeBodyIntact accepted a body missing overlay-a11y-manifest.eval.mjs',
      };
    }
  }
  const T_a11y_recipe_drop_static_shell = A11Y_RECIPE_FULL_JUSTFILE.replace(
    `    node -e "import('./evals/a11y-static-shell.eval.mjs').then(m=>m.default()).then(r=>{if(!r.pass){throw new Error(r.detail)}})"\n`,
    '',
  );
  {
    let r;
    try {
      r = a11yRecipeBodyIntact(T_a11y_recipe_drop_static_shell);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-recipe-drop-static-shell: a11yRecipeBodyIntact threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-recipe-drop-static-shell: a11yRecipeBodyIntact accepted a body missing a11y-static-shell.eval.mjs',
      };
    }
  }
  const T_a11y_recipe_drop_reduced_motion = A11Y_RECIPE_FULL_JUSTFILE.replace(
    `    node -e "import('./evals/reduced-motion-purity.eval.mjs').then(m=>m.default()).then(r=>{if(!r.pass){throw new Error(r.detail)}})"\n`,
    '',
  );
  {
    let r;
    try {
      r = a11yRecipeBodyIntact(T_a11y_recipe_drop_reduced_motion);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-recipe-drop-reduced-motion: a11yRecipeBodyIntact threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-recipe-drop-reduced-motion: a11yRecipeBodyIntact accepted a body missing reduced-motion-purity.eval.mjs',
      };
    }
  }

  // --- T-a11y-recipe-good: HOSTILE-BUT-CORRECT → must ACCEPT.
  //   - declared WITH a parameter and a dependency (`a11y-e2e floor="169": wasm`, mirrors
  //     `mutate-server cap="324":` at justfile:142).
  //   - preceded by a long `#` comment preamble block.
  //   - a DECOY `# a11y-e2e:` comment line sits BEFORE the real header (does not match
  //     extractRecipeBodyLocal's `\na11y-e2e:` / `\na11y-e2e ` markers, since it is preceded by
  //     "# " not a bare newline — traced against extractRecipeBodyLocal:348-357).
  //   - a `#` comment INSIDE the body mentions a banned/irrelevant token (`echo "a11y ok"`) —
  //     stripped by extractRecipeBodyLocal, must not affect anything.
  //   Kills: an impl whose header search is a naive regex/indexOf over raw text instead of
  //   reusing extractRecipeBodyLocal (would latch onto the decoy comment and extract nothing, or
  //   the wrong region) AND an impl that string-searches the RAW justfileText instead of the
  //   extracted body (would be fooled by the banned in-body comment token into thinking the real
  //   tokens are somehow tainted, or would false-reject on decoy noise).
  const T_a11y_recipe_good_justfile = `# Long preamble comment block describing conventions used across this justfile.
# Second line of preamble — unrelated to any recipe.
# Third line of preamble — mentions "a11y" in passing but is not a header.
# Fourth line of preamble.
# Fifth line of preamble.

# a11y-e2e:
# (decoy header-shaped comment line above — must NOT be treated as the real
# recipe header; the real header appears later, unindented, without a #.)

lint:
    echo lint

a11y-e2e floor="169": wasm
    #!/usr/bin/env bash
    set -euo pipefail
    # TODO: someday also try echo "a11y ok" here for a quick smoke (banned/
    # irrelevant token inside a body comment; must not satisfy any clause on
    # its own, and must not break extraction of the real tokens below).
    node -e "import('./evals/overlay-a11y-manifest.eval.mjs').then(m=>m.default()).then(r=>{if(!r.pass){throw new Error(r.detail)}})"
    node -e "import('./evals/a11y-static-shell.eval.mjs').then(m=>m.default()).then(r=>{if(!r.pass){throw new Error(r.detail)}})"
    node -e "import('./evals/reduced-motion-purity.eval.mjs').then(m=>m.default()).then(r=>{if(!r.pass){throw new Error(r.detail)}})"
    cd client && npx vitest run --reporter=json src/ui/overlayA11yWiring.test.ts src/ui/menuView.test.ts
    rm -f /tmp/a11y-e2e-axe.json
    PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/a11y-e2e-axe.json npx playwright test e2e/a11y.spec.ts --reporter=json
    node -e "if (s.unexpected !== 0) { process.exit(1) } console.log('A11Y-AXE OK tests=' + s.expected)"

wasm:
    wasm-pack build client-wasm --target bundler
`;
  {
    let r;
    try {
      r = a11yRecipeBodyIntact(T_a11y_recipe_good_justfile);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-recipe-good: a11yRecipeBodyIntact threw — ${e.message}`,
      };
    }
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `T-a11y-recipe-good: a11yRecipeBodyIntact should accept a hostile-but-correct recipe but rejected: ${r.reason}`,
      };
    }
  }

  // ===========================================================================================
  // m23-s11 PROOF-OF-TEETH: a11yNightlyJobIsWired(nightlyYaml) -> { ok, reason }
  //
  // The yaml declares an `a11y-e2e:` job (via extractJobBlock), is free of duplicate `jobs:` /
  // duplicate `a11y-e2e:` keys (checkNoDuplicateJobsKey / checkNoDuplicateJobKey), contains
  // EXACTLY ONE non-comment line trimming to `- run: just a11y-e2e` in the WHOLE FILE, and that
  // step plus its job carry no `if:` and no truthy `continue-on-error:` (isTruthyCoe,
  // findStepRange).
  // ===========================================================================================

  // Shared minimal "plain wired" base fixture — used both as its own simple positive check and as
  // the base for several `.replace()`-derived negatives below.
  const A11Y_NIGHTLY_MINIMAL_GOOD = `name: Nightly
on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:
jobs:
  a11y-e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v6
      - run: just a11y-e2e
      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        if: always()
        with:
          name: a11y-e2e-reports
          path: |
            /tmp/a11y-e2e-vitest.json
            /tmp/a11y-e2e-axe.json
            /tmp/a11y-e2e-rm.json
`;

  // --- T-a11y-nightly-good-basic: the plain minimal wiring → must ACCEPT.
  {
    let r;
    try {
      r = a11yNightlyJobIsWired(A11Y_NIGHTLY_MINIMAL_GOOD);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-nightly-good-basic: a11yNightlyJobIsWired threw — ${e.message}`,
      };
    }
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `T-a11y-nightly-good-basic: a11yNightlyJobIsWired should accept minimal correct wiring but rejected: ${r.reason}`,
      };
    }
  }

  // --- T-a11y-nightly-absent: no `a11y-e2e:` job anywhere → REJECT.
  //   Kills: an impl that treats an absent/empty job block as vacuously OK.
  const T_a11y_nightly_absent = `name: Nightly
on:
  workflow_dispatch:
jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  {
    let r;
    try {
      r = a11yNightlyJobIsWired(T_a11y_nightly_absent);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-nightly-absent: a11yNightlyJobIsWired threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-nightly-absent: a11yNightlyJobIsWired accepted a workflow with no a11y-e2e job',
      };
    }
  }

  // --- T-a11y-nightly-step-commented: the step exists only as `# - run: just a11y-e2e` → REJECT
  //   (zero non-comment matches, so "exactly one" fails as zero).
  //   Kills: an impl that raw-indexOf's the run line instead of line-scanning non-comment lines.
  const T_a11y_nightly_step_commented = A11Y_NIGHTLY_MINIMAL_GOOD.replace(
    '      - run: just a11y-e2e\n',
    '      # - run: just a11y-e2e\n',
  );
  {
    let r;
    try {
      r = a11yNightlyJobIsWired(T_a11y_nightly_step_commented);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-nightly-step-commented: a11yNightlyJobIsWired threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-nightly-step-commented: a11yNightlyJobIsWired accepted a job whose run step is only a # comment',
      };
    }
  }

  // --- T-a11y-nightly-or-true: `- run: just a11y-e2e || true` → REJECT (cannot fail).
  //   Kills: an impl that accepts suffixed run lines.
  const T_a11y_nightly_or_true = A11Y_NIGHTLY_MINIMAL_GOOD.replace(
    '      - run: just a11y-e2e\n',
    '      - run: just a11y-e2e || true\n',
  );
  {
    let r;
    try {
      r = a11yNightlyJobIsWired(T_a11y_nightly_or_true);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-nightly-or-true: a11yNightlyJobIsWired threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          "T-a11y-nightly-or-true: a11yNightlyJobIsWired accepted '- run: just a11y-e2e || true'",
      };
    }
  }

  // --- T-a11y-nightly-semicolon-exit0: `- run: just a11y-e2e; exit 0` → REJECT (cannot fail).
  //   Kills: an impl that accepts semicolon-suffixed run lines.
  const T_a11y_nightly_semicolon_exit0 = A11Y_NIGHTLY_MINIMAL_GOOD.replace(
    '      - run: just a11y-e2e\n',
    '      - run: just a11y-e2e; exit 0\n',
  );
  {
    let r;
    try {
      r = a11yNightlyJobIsWired(T_a11y_nightly_semicolon_exit0);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-nightly-semicolon-exit0: a11yNightlyJobIsWired threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          "T-a11y-nightly-semicolon-exit0: a11yNightlyJobIsWired accepted '- run: just a11y-e2e; exit 0'",
      };
    }
  }

  // --- T-a11y-nightly-job-if: job-level `if:` (before `steps:`) → REJECT.
  //   Kills: an impl that only checks step-level conditions.
  const T_a11y_nightly_job_if = `name: Nightly
on:
  workflow_dispatch:
jobs:
  a11y-e2e:
    runs-on: ubuntu-latest
    if: github.event_name == 'workflow_dispatch'
    steps:
      - run: just a11y-e2e
`;
  {
    let r;
    try {
      r = a11yNightlyJobIsWired(T_a11y_nightly_job_if);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-nightly-job-if: a11yNightlyJobIsWired threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: 'T-a11y-nightly-job-if: a11yNightlyJobIsWired accepted a job-level if: condition',
      };
    }
  }

  // --- T-a11y-nightly-job-coe-{true,yes,on,True,${{ true }}}: job-level truthy
  //   continue-on-error, all 5 forms isTruthyCoe recognises → each must REJECT.
  //   Kills: an impl that only checks step-level continue-on-error, or that mis-implements the
  //   truthy-value matching (case, alias, or expression form).
  const A11Y_JOB_COE_VALUES = ['true', 'yes', 'on', 'True', '${{ true }}'];
  for (const coeVal of A11Y_JOB_COE_VALUES) {
    const T_a11y_nightly_job_coe = `name: Nightly
on:
  workflow_dispatch:
jobs:
  a11y-e2e:
    runs-on: ubuntu-latest
    continue-on-error: ${coeVal}
    steps:
      - run: just a11y-e2e
`;
    let r;
    try {
      r = a11yNightlyJobIsWired(T_a11y_nightly_job_coe);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-nightly-job-coe-${coeVal}: a11yNightlyJobIsWired threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: `T-a11y-nightly-job-coe-${coeVal}: a11yNightlyJobIsWired accepted a job-level continue-on-error: ${coeVal}`,
      };
    }
  }

  // --- T-a11y-nightly-step-coe: the gate step itself carries a truthy continue-on-error as a
  //   continuation key (8-space indent, same list item — the exact run line is UNCHANGED so the
  //   "exactly one" clause still holds; only the step-level scan should catch this) → REJECT.
  //   Kills: an impl that checks job-level coe/if but never scans the step's own range
  //   (findStepRange).
  const T_a11y_nightly_step_coe = A11Y_NIGHTLY_MINIMAL_GOOD.replace(
    '      - run: just a11y-e2e\n',
    '      - run: just a11y-e2e\n        continue-on-error: true\n',
  );
  {
    let r;
    try {
      r = a11yNightlyJobIsWired(T_a11y_nightly_step_coe);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-nightly-step-coe: a11yNightlyJobIsWired threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-nightly-step-coe: a11yNightlyJobIsWired accepted a step-level truthy continue-on-error on the gate step',
      };
    }
  }

  // --- T-a11y-nightly-step-if (bonus, beyond the minimum list): same idea with `if:` instead of
  //   continue-on-error → REJECT.
  const T_a11y_nightly_step_if = A11Y_NIGHTLY_MINIMAL_GOOD.replace(
    '      - run: just a11y-e2e\n',
    '      - run: just a11y-e2e\n        if: always()\n',
  );
  {
    let r;
    try {
      r = a11yNightlyJobIsWired(T_a11y_nightly_step_if);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-nightly-step-if: a11yNightlyJobIsWired threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-nightly-step-if: a11yNightlyJobIsWired accepted a step-level if: on the gate step',
      };
    }
  }

  // --- T-a11y-nightly-dup-job (last-key-wins F1 analogue): first `a11y-e2e:` job is clean; a
  //   SECOND `a11y-e2e:` job key follows, neutered with `if: false`. Note the second block's run
  //   line does NOT match the exact literal, so the "exactly one" clause alone stays satisfied
  //   (count=1) — only the duplicate-key check can catch this → REJECT.
  //   Kills: an impl that only inspects the FIRST block extractJobBlock returns.
  const T_a11y_nightly_dup_job = `name: Nightly
on:
  workflow_dispatch:
jobs:
  a11y-e2e:
    runs-on: ubuntu-latest
    steps:
      - run: just a11y-e2e
  a11y-e2e:
    runs-on: ubuntu-latest
    if: false
    steps:
      - run: echo "neutered second a11y-e2e block"
`;
  {
    let r;
    try {
      r = a11yNightlyJobIsWired(T_a11y_nightly_dup_job);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-nightly-dup-job: a11yNightlyJobIsWired threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-nightly-dup-job: a11yNightlyJobIsWired accepted duplicate a11y-e2e: job keys (first clean, second neutered) — GitHub Actions last-key-wins executes the neutered block',
      };
    }
  }

  // --- T-a11y-nightly-dup-jobs (F9 analogue): duplicate top-level `jobs:` key → REJECT.
  //   Kills: same class as dup-job but at the top-level key.
  const T_a11y_nightly_dup_jobs = `name: Nightly
on:
  workflow_dispatch:
jobs:
  a11y-e2e:
    runs-on: ubuntu-latest
    steps:
      - run: just a11y-e2e
jobs:
  a11y-e2e:
    runs-on: ubuntu-latest
    if: false
    steps:
      - run: echo "neutered"
`;
  {
    let r;
    try {
      r = a11yNightlyJobIsWired(T_a11y_nightly_dup_jobs);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-nightly-dup-jobs: a11yNightlyJobIsWired threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-nightly-dup-jobs: a11yNightlyJobIsWired accepted a yaml with duplicate top-level jobs: keys',
      };
    }
  }

  // --- T-a11y-nightly-decoy-other-job: the EXACT literal `- run: just a11y-e2e` appears TWICE —
  //   once (correctly) in the a11y-e2e job, once (wrongly) parked in an unrelated job → the
  //   "exactly one in the whole file" clause is load-bearing here → REJECT.
  //   Kills: an impl using `.some(...)` / "at least one" instead of counting occurrences
  //   file-wide.
  const T_a11y_nightly_decoy_other_job = `name: Nightly
on:
  workflow_dispatch:
jobs:
  a11y-e2e:
    runs-on: ubuntu-latest
    steps:
      - run: just a11y-e2e
  smoke-republish:
    runs-on: ubuntu-latest
    steps:
      - run: just a11y-e2e
`;
  {
    let r;
    try {
      r = a11yNightlyJobIsWired(T_a11y_nightly_decoy_other_job);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-nightly-decoy-other-job: a11yNightlyJobIsWired threw — ${e.message}`,
      };
    }
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-nightly-decoy-other-job: a11yNightlyJobIsWired accepted two occurrences of the exact run line (one parked in an unrelated job) — "exactly one" clause is load-bearing',
      };
    }
  }

  // --- T-a11y-nightly-good-hostile: HOSTILE-BUT-CORRECT → must ACCEPT.
  //   - explicit `continue-on-error: false` on the gate step (falsy, must not trip the truthy
  //     check).
  //   - a legitimate `if: always()` on a LATER `actions/upload-artifact` step (a different step —
  //     must not be mistaken for a condition on the gate step).
  //   - a `run: |` block containing a shell `if curl ...` line BEFORE the gate step (mirrors the
  //     T_good tooth at ci-gate-wiring.eval.mjs:530-535 — a naive block-wide line scan would
  //     false-flag `if curl...` as a YAML `if:` key; it must not, since its trimmed form is
  //     "if curl..." not "if:...").
  //   - a comment line in a DIFFERENT job that mentions the run command as prose inside a `#`
  //     comment ("this job used to also `- run: just a11y-e2e` here") — must NOT be counted
  //     toward the "exactly one" total (it neither starts with `#` trimmed-equal to the exact
  //     line, nor IS the exact line after trimming — kills a naive indexOf/includes-based
  //     occurrence counter that would see 2 hits and wrongly reject this correct fixture).
  //   - three total jobs (mutation, a11y-e2e, coverage) sandwiching the target job, varying
  //     ordering/job-count from the other fixtures above (anti fixture-monoculture).
  const T_a11y_nightly_good_hostile = `name: Nightly
on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v6
      # historical note: this job used to also \`- run: just a11y-e2e\` here; moved to its own job.
      - run: just mutate-core
  a11y-e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v6
      - name: Wait for something
        run: |
          for i in $(seq 1 10); do
            if curl -s http://example.com; then echo ok; exit 0; fi
            sleep 1
          done
      - run: just a11y-e2e
        continue-on-error: false
      - name: Upload evidence
        if: always()
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: a11y-e2e-evidence
          path: /tmp/a11y-e2e-rm.json
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  {
    let r;
    try {
      r = a11yNightlyJobIsWired(T_a11y_nightly_good_hostile);
    } catch (e) {
      return {
        name,
        pass: false,
        detail: `T-a11y-nightly-good-hostile: a11yNightlyJobIsWired threw — ${e.message}`,
      };
    }
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `T-a11y-nightly-good-hostile: a11yNightlyJobIsWired should accept a hostile-but-correct job but rejected: ${r.reason}`,
      };
    }
  }

  // ===========================================================================================
  // m23-s11 ROUND 2 PROOF-OF-TEETH — the four bypasses red-team EXECUTED against round 1.
  // Every fixture below is a shape that round 1 ACCEPTED and round 2 must reject, plus the
  // matching hostile-good control proving the new clause did not simply reject everything.
  // ===========================================================================================

  // --- T-a11y-pin-exit0: `exit 0` planted directly under `set -euo pipefail`, with the ENTIRE
  //   original body left byte-identical below it. Every required token is still present, so the
  //   substring scan accepts it; the recipe runs nothing and exits 0. The verbatim pin rejects.
  {
    const gutted = A11Y_E2E_RECIPE_REGION.replace(
      '    set -euo pipefail\n',
      '    set -euo pipefail\n    exit 0\n',
    );
    const r = a11yRecipeBodyIsPinned(`lint:\n    echo lint\n\n${gutted}\nwasm:\n    echo w\n`);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-pin-exit0: a11yRecipeBodyIsPinned accepted a recipe with `exit 0` planted above a byte-identical body — the exact bypass red-team executed against the substring scan',
      };
    }
    // CONTROL: the same region unmutated must be ACCEPTED, or the pin is rejecting everything.
    const good = a11yRecipeBodyIsPinned(
      `lint:\n    echo lint\n\n${A11Y_E2E_RECIPE_REGION}\nwasm:\n    echo w\n`,
    );
    if (!good.ok) {
      return {
        name,
        pass: false,
        detail: `T-a11y-pin-exit0-control: a11yRecipeBodyIsPinned rejected its own verbatim region: ${good.reason}`,
      };
    }
  }

  // --- T-a11y-pin-deadbranch / T-a11y-pin-shebang: a dead `if false` wrapper, and a deleted
  //   shebang (invisible to any comment-STRIPPED body pin, since `#!` is a comment line).
  {
    const dead = A11Y_E2E_RECIPE_REGION.replace(
      '    set -euo pipefail\n',
      '    set -euo pipefail\n    if false; then\n',
    );
    if (a11yRecipeBodyIsPinned(dead).ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-pin-deadbranch: a11yRecipeBodyIsPinned accepted a body wrapped in `if false; then`',
      };
    }
    const noShebang = A11Y_E2E_RECIPE_REGION.replace('    #!/usr/bin/env bash\n', '');
    if (a11yRecipeBodyIsPinned(noShebang).ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-pin-shebang: a11yRecipeBodyIsPinned accepted a recipe with the `#!/usr/bin/env bash` shebang deleted — this is why the pin is over the RAW region, not the comment-stripped body',
      };
    }
  }

  // --- T-a11y-nightly-empty-matrix: an empty matrix expands to ZERO job instances.
  {
    const yml = `name: Nightly\non:\n  workflow_dispatch:\njobs:\n  a11y-e2e:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        shard: []\n    steps:\n      - run: just a11y-e2e\n`;
    if (a11yNightlyJobIsWired(yml).ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-nightly-empty-matrix: a11yNightlyJobIsWired accepted a job whose empty `matrix` expands to zero instances — declared, never scheduled, never run',
      };
    }
  }

  // --- T-a11y-nightly-phantom-runner / T-a11y-nightly-no-runs-on: a job pointed at a label no
  //   runner carries queues forever; a job with no `runs-on:` cannot be scheduled at all.
  {
    const phantom = `name: Nightly\non:\n  workflow_dispatch:\njobs:\n  a11y-e2e:\n    runs-on: [self-hosted, no-such-label]\n    steps:\n      - run: just a11y-e2e\n`;
    if (a11yNightlyJobIsWired(phantom).ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-nightly-phantom-runner: a11yNightlyJobIsWired accepted `runs-on: [self-hosted, no-such-label]` — the job never gets scheduled',
      };
    }
    const noRunsOn = `name: Nightly\non:\n  workflow_dispatch:\njobs:\n  a11y-e2e:\n    steps:\n      - run: just a11y-e2e\n`;
    if (a11yNightlyJobIsWired(noRunsOn).ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-nightly-no-runs-on: a11yNightlyJobIsWired accepted a job with no `runs-on:` key',
      };
    }
  }

  // --- T-a11y-nightly-coe-expression: `${{ !cancelled() }}` and `${{ success() || true }}` are
  //   unconditionally true in every real run, and BOTH slipped past isTruthyCoe's literal
  //   blacklist (red-team executed both). The value whitelist closes them.
  {
    const mk = (coe) =>
      `name: Nightly\non:\n  workflow_dispatch:\njobs:\n  a11y-e2e:\n    runs-on: ubuntu-latest\n    steps:\n      - run: just a11y-e2e\n        continue-on-error: ${coe}\n      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4\n        with:\n          path: /tmp/a11y-e2e-rm.json\n`;
    for (const coe of ['$' + '{{ !cancelled() }}', '$' + '{{ success() || true }}', '1', 'TRUE']) {
      if (a11yNightlyJobIsWired(mk(coe)).ok) {
        return {
          name,
          pass: false,
          detail: `T-a11y-nightly-coe-expression: a11yNightlyJobIsWired accepted an always-true continue-on-error: ${coe}`,
        };
      }
    }
    // CONTROL: the literal `false` — the ONE admitted spelling — must still pass.
    if (!a11yNightlyJobIsWired(mk('false')).ok) {
      return {
        name,
        pass: false,
        detail:
          'T-a11y-nightly-coe-expression-control: a11yNightlyJobIsWired rejected the literal `continue-on-error: false`, which is the one admitted spelling',
      };
    }
  }
  // =========================================================================
  // rb-19 PROOF-OF-TEETH — the axe-core + real-browser tier.
  //
  // Four new gates, each with per-clause negatives and a hostile-but-correct
  // positive control. Every rejection is pinned by the REASON it gives, not merely
  // by ok === false: with first-failure semantics a coarse mutant only ever proves
  // clause 1, so "rejected" and "rejected for the right reason" are different facts
  // and only the second one is evidence.
  //
  // Mutations use split/join with an EXACTLY-ONE occurrence check, never
  // String.replace: a first-occurrence replace that silently does not apply reads
  // as "the gate accepted the cheat" (measured), and a replacement string
  // containing $' duplicates the subject's tail (also measured).
  // =========================================================================

  const rb19ReplaceOnce = (src, needle, repl) => {
    const parts = src.split(needle);
    if (parts.length !== 2) return null;
    return parts[0] + repl + parts[1];
  };
  const rb19Reject = (label, res, needle) => {
    if (res.ok) {
      return `${label}: predicate ACCEPTED a known-bad fixture (expected a rejection). reason it gave: ${res.reason}`;
    }
    if (String(res.reason).indexOf(needle) === -1) {
      return `${label}: rejected, but for the WRONG reason — expected the reason to name '${needle}', got: ${res.reason}`;
    }
    return null;
  };
  const rb19Accept = (label, res) =>
    res.ok ? null : `${label}: predicate REJECTED the hostile-but-correct control: ${res.reason}`;

  // -------------------------------------------------------------------------
  // RB19-A — a11yRecipeBodyIntact's Half-3 clauses.
  // -------------------------------------------------------------------------
  const RB19_RECIPE_GOOD = [
    'lint:',
    '    echo lint',
    '',
    'a11y-e2e floor="169" axefloor="3": wasm',
    '    #!/usr/bin/env bash',
    '    set -euo pipefail',
    '    # DEFERRED: axe-core used to be skipped here — this COMMENT mentions the',
    '    # stale banner verbatim and must NOT trip the negative clause, because a',
    '    # comment prints nothing. Only the echo would have lied.',
    '    node -e "import(\'./evals/overlay-a11y-manifest.eval.mjs\')"',
    '    node -e "import(\'./evals/a11y-static-shell.eval.mjs\')"',
    '    node -e "import(\'./evals/reduced-motion-purity.eval.mjs\')"',
    '    cd client && npx vitest run --reporter=json src/ui/overlayA11yWiring.test.ts',
    '    rm -f /tmp/a11y-e2e-axe.json',
    '    PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/a11y-e2e-axe.json npx playwright test e2e/a11y.spec.ts --reporter=json',
    '    node -e "if (s.unexpected !== 0) { process.exit(1) } console.log(\'A11Y-AXE OK tests=\' + s.expected)"',
    '    cd ..',
    '',
    'wasm:',
    '    wasm-pack build client-wasm --target bundler',
    '',
  ].join('\n');

  // Fixture integrity FIRST. A base fixture that lost a token would make every
  // negative below "bite" for a reason that has nothing to do with the mutation.
  for (const token of [
    'playwright test',
    'e2e/a11y.spec.ts',
    'PLAYWRIGHT_JSON_OUTPUT_NAME',
    'A11Y-AXE OK',
  ]) {
    if (RB19_RECIPE_GOOD.split(token).length !== 2) {
      return {
        name,
        pass: false,
        detail: `RB19-A0 fixture integrity: RB19_RECIPE_GOOD contains ${RB19_RECIPE_GOOD.split(token).length - 1} occurrences of '${token}', expected exactly 1 — the drop-one-token negatives below cannot be built`,
      };
    }
  }

  {
    const bad = rb19Accept('RB19-A-good', a11yRecipeBodyIntact(RB19_RECIPE_GOOD));
    if (bad) return { name, pass: false, detail: bad };
  }

  // A1-A4: drop exactly one Half-3 token each. Each must reject NAMING that token.
  // Kills: an impl that checks "some axe token is present" instead of all four
  // independently, and an impl that only checks the first one in the list.
  const RB19_A_DROPS = [
    ['RB19-A1', 'playwright test', 'playwright-run'],
    ['RB19-A2', 'e2e/a11y.spec.ts', 'e2e/golden.spec.ts'],
    ['RB19-A3', 'PLAYWRIGHT_JSON_OUTPUT_NAME', 'PW_OUT'],
    ['RB19-A4', 'A11Y-AXE OK', 'done'],
  ];
  for (const [label, token, substitute] of RB19_A_DROPS) {
    const mutated = rb19ReplaceOnce(RB19_RECIPE_GOOD, token, substitute);
    if (mutated === null) {
      return {
        name,
        pass: false,
        detail: `${label}: mutation did not apply — '${token}' did not occur exactly once in RB19_RECIPE_GOOD. A mutation that silently does not apply reads as "the gate accepted the cheat".`,
      };
    }
    const bad = rb19Reject(label, a11yRecipeBodyIntact(mutated), token);
    if (bad) return { name, pass: false, detail: bad };
  }

  // A5: the stale deferral banner restored as a live `echo`. Every Half-3 token is
  // still present, so only the NEGATIVE clause can catch this.
  // Kills: an impl that adds the four positive token clauses and forgets that the
  // banner is now a false statement printed by a green gate.
  {
    const mutated = rb19ReplaceOnce(
      RB19_RECIPE_GOOD,
      '    cd ..\n',
      '    echo "DEFERRED: axe-core + real-browser tier is NOT run here."\n    cd ..\n',
    );
    if (mutated === null) {
      return { name, pass: false, detail: 'RB19-A5: mutation did not apply (cd .. anchor)' };
    }
    const bad = rb19Reject('RB19-A5', a11yRecipeBodyIntact(mutated), 'DEFERRED: axe-core');
    if (bad) return { name, pass: false, detail: bad };
  }

  // A6: every Half-3 token present, verbatim, but ONLY inside a `#` comment line.
  // Kills: an impl that raw-indexOfs the justfile text instead of the extracted,
  // comment-stripped recipe body.
  {
    const commented = [
      'lint:',
      '    echo lint',
      '',
      'a11y-e2e:',
      '    #!/usr/bin/env bash',
      '    set -euo pipefail',
      '    # would run: PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/x npx playwright test e2e/a11y.spec.ts',
      '    # and would print A11Y-AXE OK tests=3 (comment only, nothing executes)',
      '    node -e "import(\'./evals/overlay-a11y-manifest.eval.mjs\')"',
      '    node -e "import(\'./evals/a11y-static-shell.eval.mjs\')"',
      '    node -e "import(\'./evals/reduced-motion-purity.eval.mjs\')"',
      '    cd client && npx vitest run --reporter=json src/ui/overlayA11yWiring.test.ts',
      '',
    ].join('\n');
    if (commented.indexOf('A11Y-AXE OK') === -1) {
      return {
        name,
        pass: false,
        detail: 'RB19-A6 fixture integrity: the comment-only fixture lost its tokens',
      };
    }
    const bad = rb19Reject('RB19-A6', a11yRecipeBodyIntact(commented), 'playwright test');
    if (bad) return { name, pass: false, detail: bad };
  }

  // -------------------------------------------------------------------------
  // RB19-B — a11ySpecUsesAxe. The payload gate.
  // -------------------------------------------------------------------------
  const RB19_INCOMPLETE_LINES = [
    '  const incompleteIds = results.incomplete.map((item) => item.id);',
    '  for (const id of incompleteIds) {',
    '    expect(INCOMPLETE_ALLOWED.has(id)).toBe(true);',
    '  }',
    '  const nodeCount = results.incomplete.reduce((acc, item) => acc + item.nodes.length, 0);',
    '  expect(nodeCount).toBeLessThanOrEqual(2);',
  ];

  // HOSTILE-BUT-CORRECT control. Deliberately booby-trapped for the stripper:
  //   - a block-comment header whose PROSE names axe-core, AxeBuilder and analyze;
  //   - a live regex literal /[/*]/ (the measured stripper blinder: a naive block
  //     comment regex blanks everything after it with no throw);
  //   - a live string containing a block-comment terminator;
  //   - a live template literal containing both comment openers.
  // A stripper that mis-tokenises any of these blanks the file and this control
  // goes red — which is exactly the alarm we want.
  const RB19_SPEC_GOOD = [
    '/**',
    ' * client/e2e/a11y.spec.ts',
    ' * Scans three page states with the axe-core engine via AxeBuilder and the',
    ' * analyze entry point. This header is PROSE: everything it names must also',
    ' * exist as live code below, or the gate is reading a description of a test.',
    ' */',
    "import AxeBuilder from '@axe-core/playwright';",
    "import { expect, test } from '@playwright/test';",
    '',
    "const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];",
    '// best-practice is deliberately excluded from TAGS.',
    'const PASS_FLOOR = 16;',
    "const INCOMPLETE_ALLOWED = new Set(['color-contrast']);",
    'const SLASH_STAR_CLASS = /[/*]/;',
    "const TAIL = 'a literal block-comment terminator */ inside a string';",
    'const NOTE = `a template literal with // and /* inside it`;',
    '',
    'async function runAxe(page) {',
    '  const results = await new AxeBuilder({ page })',
    '    .withTags(TAGS)',
    "    .exclude('canvas')",
    '    .analyze();',
    '  expect(results.violations).toEqual([]);',
    '  expect(results.passes.length).toBeGreaterThanOrEqual(PASS_FLOOR);',
    ...RB19_INCOMPLETE_LINES,
    '  return results;',
    '}',
    '',
    "test('connected world chrome is axe-clean', async ({ page }) => {",
    "  await page.goto('/');",
    "  await expect(page.locator('#hud')).toBeVisible();",
    '  await runAxe(page);',
    '});',
    '',
    "test('help overlay is axe-clean', async ({ page }) => {",
    "  await page.goto('/');",
    "  await page.keyboard.press('Shift+Slash');",
    "  await expect(page.locator('#help-overlay')).toBeVisible();",
    '  await runAxe(page);',
    '});',
    '',
    "test('menu overlay is axe-clean', async ({ page }) => {",
    "  await page.goto('/');",
    "  await page.keyboard.press('KeyM');",
    "  await expect(page.locator('#menu-overlay')).toBeVisible();",
    '  await runAxe(page);',
    '});',
    '',
    'test.afterAll(async ({ browser }) => {',
    '  await browser.close();',
    '});',
    '',
  ].join('\n');

  // Fixture integrity. A stray backtick silently terminates a template literal with
  // NO error (measured), and the whole B group would then be scanning garbage.
  {
    const backticks = RB19_SPEC_GOOD.split('`').length - 1;
    if (backticks !== 2) {
      return {
        name,
        pass: false,
        detail: `RB19-B0 fixture integrity: RB19_SPEC_GOOD holds ${backticks} backticks, expected exactly 2 (the single template literal on the NOTE line)`,
      };
    }
    if (RB19_SPEC_GOOD.length < 1200) {
      return {
        name,
        pass: false,
        detail: `RB19-B0 fixture integrity: RB19_SPEC_GOOD is ${RB19_SPEC_GOOD.length} bytes, expected >= 1200 — a truncated fixture would trip the stripper-sanity clause instead of the clause under test`,
      };
    }
    for (const needle of [
      "import AxeBuilder from '@axe-core/playwright';",
      'new AxeBuilder({ page })',
      '    .analyze();',
      '  expect(results.violations).toEqual([]);',
      "'wcag2aa', ",
      "'KeyM'",
    ]) {
      if (RB19_SPEC_GOOD.split(needle).length !== 2) {
        return {
          name,
          pass: false,
          detail: `RB19-B0 fixture integrity: '${needle}' occurs ${RB19_SPEC_GOOD.split(needle).length - 1} times in RB19_SPEC_GOOD, expected exactly 1`,
        };
      }
    }
  }

  {
    const bad = rb19Accept('RB19-B-good', a11ySpecUsesAxe(RB19_SPEC_GOOD));
    if (bad) return { name, pass: false, detail: bad };
  }

  // B1-B7, B10: one surgical mutation each, each pinned by the reason's needle.
  //   B1 no import                 kills: a gate that only looks for AxeBuilder
  //   B2 constructed -> not        kills: a gate satisfied by the import alone
  //   B3 analyze never called      kills: the measured co-occurrence hole — counting
  //                                declaration + capture + invocation pins no call site
  //   B4 result never asserted     kills: a gate satisfied by a scan whose result is dropped
  //   B5 no non-vacuity floor      kills: the blank-page false green (0 passes, 0 violations)
  //   B6 wcag2aa dropped           kills: an unquoted tag test ('wcag2a' substrings 'wcag2aa')
  //   B7 incomplete ceiling gone   kills: silent pass -> needs-review rule degradation
  //   B10 one state dropped        kills: a one-state spec that satisfies everything else
  const RB19_B_MUTANTS = [
    ['RB19-B1', "import AxeBuilder from '@axe-core/playwright';\n", '', '@axe-core/playwright'],
    ['RB19-B2', 'new AxeBuilder({ page })', 'buildScanner({ page })', "'new AxeBuilder('"],
    ['RB19-B3', '    .analyze();', '    .noopScan();', "'.analyze()'"],
    ['RB19-B4', '  expect(results.violations).toEqual([]);\n', '', 'violations'],
    [
      'RB19-B5',
      '  expect(results.passes.length).toBeGreaterThanOrEqual(PASS_FLOOR);\n',
      '',
      'passes',
    ],
    ['RB19-B6', "'wcag2aa', ", '', 'wcag2aa'],
    // B6 mutates the tag LIST; without B18 the `.withTags(` clause itself could be
    // DELETED whole and nothing fired. Measured: red-team hollowed every clause in
    // turn and this was the only one with no tooth.
    ['RB19-B18', '.withTags(TAGS)', '.withRules([])', 'withTags'],
    ['RB19-B7', `${RB19_INCOMPLETE_LINES.join('\n')}\n`, '', 'incomplete'],
    ['RB19-B10', "'KeyM'", "'KeyN'", 'KeyM'],
  ];
  for (const [label, needle, repl, reasonNeedle] of RB19_B_MUTANTS) {
    const mutated = rb19ReplaceOnce(RB19_SPEC_GOOD, needle, repl);
    if (mutated === null) {
      return {
        name,
        pass: false,
        detail: `${label}: mutation did not apply — the needle did not occur exactly once in RB19_SPEC_GOOD (${RB19_SPEC_GOOD.split(needle).length - 1} occurrences). A no-op mutation reads as "the gate accepted the cheat".`,
      };
    }
    const bad = rb19Reject(label, a11ySpecUsesAxe(mutated), reasonNeedle);
    if (bad) return { name, pass: false, detail: bad };
  }

  // B8: every axe token present verbatim, but ONLY inside comments, on top of a
  // real Playwright spec that navigates and asserts (so the file is NOT
  // comment-dominated and the stripper-sanity clause cannot fire instead).
  // Kills: any impl that scans raw source. This is the single highest-yield bypass
  // for a payload gate, because every token here is an ordinary English word an
  // author writes in the header anyway.
  {
    const RB19_SPEC_COMMENT_ONLY = [
      '// TODO(rb-19): wire the real scan. Intended shape, for reference:',
      "//   import AxeBuilder from '@axe-core/playwright';",
      "//   const TAGS = ['wcag2a', 'wcag2aa'];",
      '//   const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();',
      '//   expect(results.violations).toEqual([]);',
      '//   expect(results.passes.length).toBeGreaterThan(10);',
      '//   expect(results.incomplete.length).toBeLessThanOrEqual(2);',
      "import { expect, test } from '@playwright/test';",
      '',
      "test('connected world chrome renders', async ({ page }) => {",
      "  await page.goto('/');",
      "  await expect(page.locator('#hud')).toBeVisible();",
      "  await expect(page.locator('#build-stamp')).toBeVisible();",
      '});',
      '',
      "test('help overlay opens', async ({ page }) => {",
      "  await page.goto('/');",
      "  await page.keyboard.press('Shift+Slash');",
      "  await expect(page.locator('#help-overlay')).toBeVisible();",
      '});',
      '',
      "test('menu overlay opens', async ({ page }) => {",
      "  await page.goto('/');",
      "  await page.keyboard.press('KeyM');",
      "  await expect(page.locator('#menu-overlay')).toBeVisible();",
      '});',
      '',
    ].join('\n');
    if (RB19_SPEC_COMMENT_ONLY.indexOf(AXE_DEP_NAME) === -1) {
      return {
        name,
        pass: false,
        detail: 'RB19-B8 fixture integrity: the comment-only spec lost its commented axe import',
      };
    }
    const bad = rb19Reject('RB19-B8', a11ySpecUsesAxe(RB19_SPEC_COMMENT_ONLY), AXE_DEP_NAME);
    if (bad) return { name, pass: false, detail: bad };
  }

  // B9: absent/empty spec must FAIL loudly, never read as a skip. This is the exact
  // shape of the rb-19 RED-before state.
  {
    const bad = rb19Reject('RB19-B9', a11ySpecUsesAxe(''), 'empty or unreadable');
    if (bad) return { name, pass: false, detail: bad };
  }

  // B11: the stripper-sanity clause itself. A file that is 99% comment must be
  // reported AS unscannable, not as "token missing" and not as ok.
  {
    const hollow = `${'// filler comment line to make this file large and empty\n'.repeat(40)}const x = 1;\n`;
    const bad = rb19Reject('RB19-B11', a11ySpecUsesAxe(hollow), 'comment-stripper returned');
    if (bad) return { name, pass: false, detail: bad };
  }

  // -------------------------------------------------------------------------
  // RB19-B12..B17 — the M3 class: a gate needle satisfied by the AUDITED FILE's
  // own failure-message strings. B12/B13/B14 are the surviving mutant's shape
  // applied to each of the three assertion clauses; B15 is the anti-over-fit
  // control that keeps the fix spelling-blind; B16/B17 pin the two halves of
  // "asserted" that presence-scanning cannot see.
  // -------------------------------------------------------------------------
  const RB19_VIOLATIONS_LINE = '  expect(results.violations).toEqual([]);';
  const RB19_PASSES_LINE = '  expect(results.passes.length).toBeGreaterThanOrEqual(PASS_FLOOR);';

  // B12: the EXACT surviving mutant, generalised. The subject is gutted; the token
  // survives only inside the failure-message template of that same expect — including
  // a ${...} interpolation, so the template scanner is exercised, not just a plain
  // string. Kills: any proximity/radius check, and any string-blanker that stops at
  // the first backtick instead of recursing through the interpolation.
  {
    const mutated = rb19ReplaceOnce(
      RB19_SPEC_GOOD,
      RB19_VIOLATIONS_LINE,
      '  expect(SUBJECT_GUTTED, `axe reported violations: ${fmt(results.violations)}`).toEqual([]);',
    );
    if (mutated === null) {
      return { name, pass: false, detail: 'RB19-B12: mutation did not apply (violations line)' };
    }
    const bad = rb19Reject('RB19-B12', a11ySpecUsesAxe(mutated), "'violations'");
    if (bad) return { name, pass: false, detail: bad };
  }

  // B13: the same shape on the non-vacuity floor. `toBeGreaterThanOrEqual` is still
  // present and still applied — to a constant. Kills: the file-wide
  // `indexOf('toBeGreaterThan')` existence check, which cannot tell WHAT was bounded.
  {
    const mutated = rb19ReplaceOnce(
      RB19_SPEC_GOOD,
      RB19_PASSES_LINE,
      '  expect(FLOOR_GUTTED, `only ${results.passes.length} passes seen`).toBeGreaterThanOrEqual(PASS_FLOOR);',
    );
    if (mutated === null) {
      return { name, pass: false, detail: 'RB19-B13: mutation did not apply (passes line)' };
    }
    const bad = rb19Reject('RB19-B13', a11ySpecUsesAxe(mutated), 'passes');
    if (bad) return { name, pass: false, detail: bad };
  }

  // B14: the same shape on the undecidable ceiling.
  {
    const mutated = rb19ReplaceOnce(
      RB19_SPEC_GOOD,
      `${RB19_INCOMPLETE_LINES.join('\n')}\n`,
      '  expect(CEILING_GUTTED, `${results.incomplete.length} undecidable node(s)`).toBeLessThanOrEqual(2);\n',
    );
    if (mutated === null) {
      return { name, pass: false, detail: 'RB19-B14: mutation did not apply (incomplete block)' };
    }
    const bad = rb19Reject('RB19-B14', a11ySpecUsesAxe(mutated), 'incomplete');
    if (bad) return { name, pass: false, detail: bad };
  }

  // B15: ANTI-OVER-FIT CONTROL — the fixture whose whole job is to fail if a future
  // maintainer (or I) tightens these clauses into "one blessed spelling". A different
  // matcher (toHaveLength) on a differently-named alias must still ACCEPT. Without
  // this, the honest way to make B12 bite is to pin the shipped byte sequence, and
  // the gate gets deleted the first time somebody reformats the spec.
  {
    const respelled = rb19ReplaceOnce(
      RB19_SPEC_GOOD,
      RB19_VIOLATIONS_LINE,
      '  const foundViolations = results.violations;\n  expect(foundViolations).toHaveLength(0);',
    );
    if (respelled === null) {
      return { name, pass: false, detail: 'RB19-B15: mutation did not apply (violations line)' };
    }
    const bad = rb19Accept('RB19-B15', a11ySpecUsesAxe(respelled));
    if (bad) return { name, pass: false, detail: bad };
  }

  // B16: the token is present in LIVE CODE — not a comment, not a message — and is
  // simply never asserted. Kills: "blank the strings and keep using indexOf", which
  // would close M3 while leaving `const ignored = results.violations;` green.
  {
    const mutated = rb19ReplaceOnce(
      RB19_SPEC_GOOD,
      RB19_VIOLATIONS_LINE,
      '  const ignoredFindings = results.violations;',
    );
    if (mutated === null) {
      return { name, pass: false, detail: 'RB19-B16: mutation did not apply (violations line)' };
    }
    const bad = rb19Reject('RB19-B16', a11ySpecUsesAxe(mutated), "'violations'");
    if (bad) return { name, pass: false, detail: bad };
  }

  // B17: the right subject, in a real expect(...), with NO matcher invoked. Same
  // declaration-vs-invocation distinction the .analyze() clause draws one level up:
  // `expect(x);` builds an assertion object and checks nothing.
  {
    const mutated = rb19ReplaceOnce(
      RB19_SPEC_GOOD,
      RB19_VIOLATIONS_LINE,
      '  expect(results.violations);',
    );
    if (mutated === null) {
      return { name, pass: false, detail: 'RB19-B17: mutation did not apply (violations line)' };
    }
    const bad = rb19Reject('RB19-B17', a11ySpecUsesAxe(mutated), "'violations'");
    if (bad) return { name, pass: false, detail: bad };
  }

  // -------------------------------------------------------------------------
  // RB19-C — clientDeclaresAxeDep.
  // -------------------------------------------------------------------------
  const RB19_LOCK_GOOD = JSON.stringify({
    name: 'monster-realm-client',
    lockfileVersion: 3,
    packages: {
      '': { name: 'monster-realm-client' },
      'node_modules/@axe-core/playwright': { version: '4.13.0', dev: true },
    },
  });

  // HOSTILE-BUT-CORRECT: a description string containing the package name verbatim
  // (the substring-scan decoy), a similarly-named RUNTIME dependency that must not
  // be mistaken for it, and the real declaration last in key order.
  const rb19Pkg = (devSpec, extra) => {
    const obj = {
      name: 'monster-realm-client',
      description: `client; e2e a11y tier uses ${AXE_DEP_NAME} under playwright`,
      dependencies: { 'pixi.js': '^8.19.0', '@axe-core/playwright-helper': '^1.0.0' },
      devDependencies: { '@playwright/test': '^1.61.0' },
    };
    if (devSpec !== null) obj.devDependencies[AXE_DEP_NAME] = devSpec;
    if (extra !== null) obj.dependencies[AXE_DEP_NAME] = extra;
    return JSON.stringify(obj, null, 2);
  };

  {
    const bad = rb19Accept(
      'RB19-C-good',
      clientDeclaresAxeDep(rb19Pkg('4.13.0', null), RB19_LOCK_GOOD),
    );
    if (bad) return { name, pass: false, detail: bad };
  }

  // C1: declared nowhere, but the package name IS present as a description value.
  // Kills: a substring scan over package.json.
  {
    const bad = rb19Reject(
      'RB19-C1',
      clientDeclaresAxeDep(rb19Pkg(null, null), RB19_LOCK_GOOD),
      'declares no',
    );
    if (bad) return { name, pass: false, detail: bad };
  }

  // C2: declared under `dependencies` instead of `devDependencies`.
  // Kills: an impl that merges both maps before looking.
  {
    const bad = rb19Reject(
      'RB19-C2',
      clientDeclaresAxeDep(rb19Pkg(null, '4.13.0'), RB19_LOCK_GOOD),
      'runtime dependency',
    );
    if (bad) return { name, pass: false, detail: bad };
  }

  // C2b: declared in BOTH. Must still reject — checking devDependencies first would
  // accept this and leave axe-core on the shipped dependency graph.
  {
    const bad = rb19Reject(
      'RB19-C2b',
      clientDeclaresAxeDep(rb19Pkg('4.13.0', '4.13.0'), RB19_LOCK_GOOD),
      'runtime dependency',
    );
    if (bad) return { name, pass: false, detail: bad };
  }

  // C3-C6: four range spellings. A whitelist (exact semver) closes all of them;
  // a blacklist of ^ ~ * x does not — this repo has measured that asymmetry.
  for (const [label, range] of [
    ['RB19-C3', '^4.13.0'],
    ['RB19-C4', '~4.13.0'],
    ['RB19-C5', '*'],
    ['RB19-C6', '4.x'],
    ['RB19-C6b', '>=4.13.0 <5'],
    ['RB19-C6c', 'latest'],
  ]) {
    const bad = rb19Reject(
      label,
      clientDeclaresAxeDep(rb19Pkg(range, null), RB19_LOCK_GOOD),
      'EXACT version is required',
    );
    if (bad) return { name, pass: false, detail: bad };
  }

  // C7: exact pin in package.json, absent from the lockfile — `npm ci` hard-errors
  // before the gate ever runs.
  {
    const lockNoAxe = JSON.stringify({
      name: 'monster-realm-client',
      lockfileVersion: 3,
      packages: { '': { name: 'monster-realm-client' } },
    });
    const bad = rb19Reject(
      'RB19-C7',
      clientDeclaresAxeDep(rb19Pkg('4.13.0', null), lockNoAxe),
      "has no 'node_modules/@axe-core/playwright' entry",
    );
    if (bad) return { name, pass: false, detail: bad };
  }

  // C8: present in the lockfile at a DIFFERENT version. Kills: a lockfile check that
  // only asks "is the name mentioned".
  {
    const lockSkew = JSON.stringify({
      name: 'monster-realm-client',
      lockfileVersion: 3,
      packages: {
        '': { name: 'monster-realm-client' },
        'node_modules/@axe-core/playwright': { version: '4.12.0', dev: true },
      },
    });
    const bad = rb19Reject(
      'RB19-C8',
      clientDeclaresAxeDep(rb19Pkg('4.13.0', null), lockSkew),
      'locks it at',
    );
    if (bad) return { name, pass: false, detail: bad };
  }

  // C9: unparseable package.json must fail loudly, not throw and not pass.
  {
    const bad = rb19Reject(
      'RB19-C9',
      clientDeclaresAxeDep('{ "name": "x", ', RB19_LOCK_GOOD),
      'not parseable JSON',
    );
    if (bad) return { name, pass: false, detail: bad };
  }

  // C10: an empty lockfile.
  {
    const bad = rb19Reject(
      'RB19-C10',
      clientDeclaresAxeDep(rb19Pkg('4.13.0', null), ''),
      'empty or unreadable',
    );
    if (bad) return { name, pass: false, detail: bad };
  }

  // -------------------------------------------------------------------------
  // RB19-D — jobBlockMatchesPin / a11yNightlyJobIsPinned, and the token twin.
  //
  // The pin's fixtures deliberately do NOT use A11Y_E2E_NIGHTLY_JOB_BLOCK: the
  // tester cannot know the finished job's bytes, and a fixture written against a
  // placeholder proves nothing. They pin a SYNTHETIC block the fixture owns.
  // -------------------------------------------------------------------------
  const RB19_SYN_NIGHTLY = [
    'name: Nightly',
    'on:',
    '  workflow_dispatch:',
    'jobs:',
    '  a11y-e2e:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v6 # v6',
    '      - name: Install SpacetimeDB CLI',
    '        run: |',
    '          curl -sSf -o /tmp/spacetime-install.sh https://install.spacetimedb.com',
    '          sh /tmp/spacetime-install.sh --yes',
    '      - name: Pin spacetime 2.8.1',
    '        run: |',
    '          spacetime version install 2.8.1',
    '          spacetime version use 2.8.1',
    '      - name: Start SpacetimeDB',
    '        run: nohup spacetime start --in-memory --listen-addr 127.0.0.1:3000 &',
    '      - name: Wait for SpacetimeDB',
    '        run: |',
    '          for i in $(seq 1 60); do',
    '            if curl -s -o /dev/null http://127.0.0.1:3000/; then exit 0; fi',
    '            sleep 1',
    '          done',
    '          exit 1',
    '      - name: Install a browser',
    '        run: cd client && npx playwright install --with-deps chromium',
    '      - name: Install client deps',
    '        run: cd client && npm ci',
    '      - run: just a11y-e2e',
    '        env:',
    "          MR_E2E_PORT: '5291'",
    '          STDB_SERVER: http://127.0.0.1:3000',
    '          VITE_STDB_URI: ws://127.0.0.1:3000',
    '          VITE_STDB_DB: monster-realm-a11y',
    '  coverage:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: just coverage',
    '',
  ].join('\n');

  const RB19_SYN_PIN = extractJobBlock(RB19_SYN_NIGHTLY, 'a11y-e2e');
  if (RB19_SYN_PIN.trim() === '' || RB19_SYN_PIN.indexOf('- run: just a11y-e2e') === -1) {
    return {
      name,
      pass: false,
      detail:
        'RB19-D0 fixture integrity: extractJobBlock returned no usable a11y-e2e block from the synthetic nightly fixture',
    };
  }

  {
    const bad = rb19Accept(
      'RB19-D-good',
      jobBlockMatchesPin(RB19_SYN_NIGHTLY, RB19_SYN_PIN, 'RB19_SYN_PIN'),
    );
    if (bad) return { name, pass: false, detail: bad };
  }

  // D1: an unfilled placeholder pin must REFUSE, not vacuously accept.
  // Kills: shipping the constant as-is and calling the gate wired.
  {
    const bad = rb19Reject(
      'RB19-D1',
      jobBlockMatchesPin(RB19_SYN_NIGHTLY, '<<<RB19-PENDING>>>', 'RB19_SYN_PIN'),
      'placeholder',
    );
    if (bad) return { name, pass: false, detail: bad };
  }

  // D2: the measured $GITHUB_PATH shim. A step that prepends a directory holding a
  // `just` shim is inserted before the gate step; the exact run line, the runner,
  // the absence of if:/continue-on-error and every prereq token all still read
  // clean. Only the verbatim pin sees the inserted step.
  {
    const shimmed = rb19ReplaceOnce(
      RB19_SYN_NIGHTLY,
      '      - run: just a11y-e2e\n',
      '      - name: toolchain helper\n        run: echo "/tmp/shim" >> "$GITHUB_PATH"\n      - run: just a11y-e2e\n',
    );
    if (shimmed === null) {
      return { name, pass: false, detail: 'RB19-D2: mutation did not apply (gate step anchor)' };
    }
    const bad = rb19Reject(
      'RB19-D2',
      jobBlockMatchesPin(shimmed, RB19_SYN_PIN, 'RB19_SYN_PIN'),
      'byte for byte',
    );
    if (bad) return { name, pass: false, detail: bad };
    // The shim is INVISIBLE to the token twin — stated, not assumed. This is the
    // whole argument for carrying a verbatim pin alongside the token clauses.
    const twin = a11yNightlyJobHasAxePrereqs(shimmed);
    if (!twin.ok) {
      return {
        name,
        pass: false,
        detail: `RB19-D2b: the token twin was expected to be BLIND to an inserted PATH-shim step (that is why the verbatim pin exists), but it rejected: ${twin.reason}`,
      };
    }
  }

  // D3: a single whitespace change. Proves the comparison is byte-level, not a
  // normalised or trimmed one. The anchor is the checkout line, NOT `runs-on:`:
  // `    runs-on: ubuntu-latest` occurs TWICE in the fixture (a11y-e2e and
  // coverage), so a replace keyed on it would silently not apply and the tooth
  // would read as "the gate accepted the cheat".
  {
    const respaced = rb19ReplaceOnce(
      RB19_SYN_NIGHTLY,
      '      - uses: actions/checkout@v6 # v6\n',
      '      - uses: actions/checkout@v6  # v6\n',
    );
    if (respaced === null) {
      return { name, pass: false, detail: 'RB19-D3: mutation did not apply (checkout anchor)' };
    }
    const bad = rb19Reject(
      'RB19-D3',
      jobBlockMatchesPin(respaced, RB19_SYN_PIN, 'RB19_SYN_PIN'),
      'byte for byte',
    );
    if (bad) return { name, pass: false, detail: bad };
  }

  // D4: the job deleted entirely — an absent job is not a vacuous pass.
  {
    const noJob =
      'name: Nightly\non:\n  workflow_dispatch:\njobs:\n  coverage:\n    runs-on: ubuntu-latest\n    steps:\n      - run: just coverage\n';
    const bad = rb19Reject(
      'RB19-D4',
      jobBlockMatchesPin(noJob, RB19_SYN_PIN, 'RB19_SYN_PIN'),
      'declares no',
    );
    if (bad) return { name, pass: false, detail: bad };
  }

  // D5: last-key-wins. extractJobBlock returns the FIRST block, so a clean first
  // plus a neutered second reads identical to the pin unless the duplicate guard
  // runs BEFORE the comparison.
  {
    const dup = `${RB19_SYN_NIGHTLY}  a11y-e2e:\n    runs-on: ubuntu-latest\n    if: false\n    steps:\n      - run: echo neutered\n`;
    const bad = rb19Reject(
      'RB19-D5',
      jobBlockMatchesPin(dup, RB19_SYN_PIN, 'RB19_SYN_PIN'),
      'duplicate',
    );
    if (bad) return { name, pass: false, detail: bad };
  }

  // D6: the EXPORTED wrapper must delegate, not shortcut. This assertion holds both
  // before the implementer fills the constant (placeholder refusal) and after it
  // (the real pin cannot equal this synthetic block), so it can never be satisfied
  // by `return { ok: true }`.
  {
    const wrapped = a11yNightlyJobIsPinned(RB19_SYN_NIGHTLY);
    if (wrapped.ok) {
      return {
        name,
        pass: false,
        detail:
          'RB19-D6: a11yNightlyJobIsPinned ACCEPTED a synthetic nightly.yml that cannot possibly match the real pinned job block — the exported wrapper is not delegating to the comparison',
      };
    }
  }

  // -------------------------------------------------------------------------
  // RB19-E — a11yNightlyJobHasAxePrereqs (the token twin of the pin).
  // -------------------------------------------------------------------------
  {
    const bad = rb19Accept('RB19-E-good', a11yNightlyJobHasAxePrereqs(RB19_SYN_NIGHTLY));
    if (bad) return { name, pass: false, detail: bad };
  }

  // E1-E8: one prereq token neutralised at a time. Each must reject NAMING it.
  // Kills: an impl that checks "some prereq is present", and an impl that only
  // checks the browser install while the server env silently disappears (the axe
  // spec would then scan a disconnected — and therefore nearly empty — page, which
  // is the false-green the passes floor in the spec exists to catch).
  for (const token of [
    'playwright install',
    'chromium',
    'spacetime version install',
    'spacetime start',
    'MR_E2E_PORT',
    'STDB_SERVER',
    'VITE_STDB_URI',
    'VITE_STDB_DB',
  ]) {
    const mutated = rb19ReplaceOnce(RB19_SYN_NIGHTLY, token, 'ZZZ_REMOVED');
    if (mutated === null) {
      return {
        name,
        pass: false,
        detail: `RB19-E: mutation did not apply — '${token}' does not occur exactly once in RB19_SYN_NIGHTLY (${RB19_SYN_NIGHTLY.split(token).length - 1} occurrences)`,
      };
    }
    const bad = rb19Reject(`RB19-E:${token}`, a11yNightlyJobHasAxePrereqs(mutated), token);
    if (bad) return { name, pass: false, detail: bad };
  }

  // E9: every prereq token present, but only on `#` comment lines.
  // Kills: a raw indexOf over the job block.
  {
    const commented = [
      'name: Nightly',
      'on:',
      '  workflow_dispatch:',
      'jobs:',
      '  a11y-e2e:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      # TODO: spacetime version install 2.8.1 then spacetime start --in-memory',
      '      # TODO: npx playwright install --with-deps chromium',
      '      # TODO: env MR_E2E_PORT STDB_SERVER VITE_STDB_URI VITE_STDB_DB',
      '      - run: just a11y-e2e',
      '',
    ].join('\n');
    const bad = rb19Reject('RB19-E9', a11yNightlyJobHasAxePrereqs(commented), 'playwright install');
    if (bad) return { name, pass: false, detail: bad };
  }

  // E10: all prereqs present but the gate step suffixed so it can no longer fail.
  // Kills: an impl that checks prereqs and forgets the step they exist to serve.
  {
    const suffixed = rb19ReplaceOnce(
      RB19_SYN_NIGHTLY,
      '      - run: just a11y-e2e\n',
      '      - run: just a11y-e2e || true\n',
    );
    if (suffixed === null) {
      return { name, pass: false, detail: 'RB19-E10: mutation did not apply (gate step anchor)' };
    }
    const bad = rb19Reject(
      'RB19-E10',
      a11yNightlyJobHasAxePrereqs(suffixed),
      'exactly one is required',
    );
    if (bad) return { name, pass: false, detail: bad };
  }

  // =========================================================================
  // rb-19 ROUND 2 — teeth for a11yStaysNightlyOnly. Every one of these three
  // promotions was EXECUTED by red-team against the shipped tree and took the whole
  // eval suite green, so they are reproduced here as fixtures rather than described.
  // =========================================================================
  {
    const NO_JF = [
      '# a stub justfile with the real ci: dependency line',
      'ci: lint typecheck test eval security wasm client-typecheck client-test observability-validate',
      '    @echo ci',
      '',
      'coverage: wasm',
      '    @echo coverage',
      '',
      'a11y-e2e floor="169" axefloor="3": wasm',
      '    @echo a11y',
      '',
    ].join('\n');
    const NO_CI = [
      'jobs:',
      '  ci:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: just lint',
      '      - run: just test',
      '',
    ].join('\n');

    // T-nightly-only-good: the shipped shape is ACCEPTED.
    {
      const r = a11yStaysNightlyOnly(NO_JF, NO_CI);
      if (!r.ok) {
        return {
          name,
          pass: false,
          detail: `T-nightly-only-good: a11yStaysNightlyOnly should accept a clean tree but rejected: ${r.reason}`,
        };
      }
    }

    // T-nightly-only-ci-dep: `ci:` gains a direct dependency.
    {
      const r = a11yStaysNightlyOnly(
        NO_JF.split('observability-validate\n').join('observability-validate a11y-e2e\n'),
        NO_CI,
      );
      if (r.ok || String(r.reason).indexOf("'ci:' recipe depends on") === -1) {
        return {
          name,
          pass: false,
          detail: `T-nightly-only-ci-dep: promoting a11y-e2e to a direct ci: dependency must be rejected by the dependency-closure clause, got ${JSON.stringify(r)}`,
        };
      }
    }

    // T-nightly-only-transitive: `ci:` never names a11y-e2e; it names `coverage`,
    // which does. This is the one a direct-name check would miss.
    {
      const r = a11yStaysNightlyOnly(
        NO_JF.split('observability-validate\n')
          .join('observability-validate coverage\n')
          .split('coverage: wasm')
          .join('coverage: wasm a11y-e2e'),
        NO_CI,
      );
      if (r.ok || String(r.reason).indexOf('transitively') === -1) {
        return {
          name,
          pass: false,
          detail: `T-nightly-only-transitive: a TRANSITIVE ci: dependency (ci -> coverage -> a11y-e2e) must be rejected, got ${JSON.stringify(r)}`,
        };
      }
    }

    // T-nightly-only-ci-yml: no justfile edit at all — just a step in ci.yml.
    {
      const r = a11yStaysNightlyOnly(NO_JF, `${NO_CI}      - run: just a11y-e2e\n`);
      if (r.ok || String(r.reason).indexOf('ci.yml carries') === -1) {
        return {
          name,
          pass: false,
          detail: `T-nightly-only-ci-yml: a bare '- run: just a11y-e2e' step in ci.yml must be rejected, got ${JSON.stringify(r)}`,
        };
      }
    }

    // T-nightly-only-comment: a COMMENTED step is not a promotion.
    {
      const r = a11yStaysNightlyOnly(NO_JF, `${NO_CI}      # - run: just a11y-e2e\n`);
      if (!r.ok) {
        return {
          name,
          pass: false,
          detail: `T-nightly-only-comment: a commented-out ci.yml step must NOT be read as a promotion, but was rejected: ${r.reason}`,
        };
      }
    }
  }

  // =========================================================================
  // rb-20 (residual R-m23-s11-X11) PROOF-OF-TEETH — reducedMotionProjectIsWired
  // =========================================================================
  {
    const RM_PROJECTS_BLOCK = `  projects: [
    { name: 'default', testIgnore: 'reduced-motion.spec.ts' },
    {
      name: 'reduced-motion',
      testMatch: 'reduced-motion.spec.ts',
      use: { contextOptions: { reducedMotion: 'reduce' } },
    },
  ],
`;
    const RM_GOOD = `import { defineConfig } from '@playwright/test';

const e2eBaseUrl = 'http://localhost:5290';

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  globalSetup: './e2e/global-setup.ts',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: e2eBaseUrl, headless: true },
  webServer: {
    command: 'npm run dev',
    url: e2eBaseUrl,
    reuseExistingServer: false,
    timeout: 60_000,
  },
${RM_PROJECTS_BLOCK}});
`;

    // --- RM-good: the healthy shape → accept.
    {
      const r = reducedMotionProjectIsWired(RM_GOOD);
      if (!r.ok) {
        return {
          name,
          pass: false,
          detail: `RM-good: reducedMotionProjectIsWired should accept the healthy shape but rejected: ${r.reason}`,
        };
      }
    }

    // --- RM-no-projects: no `projects:` array at all → reject.
    //   Kills: an impl that only inspects the top-level `use:` block and never
    //   checks for a dedicated project.
    {
      const noProjects = RM_GOOD.split(RM_PROJECTS_BLOCK).join('');
      const r = reducedMotionProjectIsWired(noProjects);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            'RM-no-projects: reducedMotionProjectIsWired should reject a config with no `projects:` array',
        };
      }
    }

    // --- RM-name-renamed: the project exists but is not named 'reduced-motion'
    //   → reject. Kills: an impl that finds ANY project carrying
    //   contextOptions.reducedMotion regardless of its name (so a project named
    //   e.g. 'chromium-rm' would satisfy RM-1 without satisfying the ledger's
    //   literal project-name expectation, and `--project=reduced-motion` in the
    //   justfile would then name nothing).
    {
      const renamed = RM_GOOD.split("name: 'reduced-motion'").join("name: 'chromium-rm'");
      const r = reducedMotionProjectIsWired(renamed);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            'RM-name-renamed: reducedMotionProjectIsWired should reject a renamed reduced-motion project',
        };
      }
    }

    // --- RM-no-contextOptions: reducedMotion dropped entirely → reject.
    //   Kills: an impl satisfied by the project's mere EXISTENCE.
    {
      const noCtx = RM_GOOD.split("use: { contextOptions: { reducedMotion: 'reduce' } },").join(
        'use: {},',
      );
      const r = reducedMotionProjectIsWired(noCtx);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            'RM-no-contextOptions: reducedMotionProjectIsWired should reject a project with no contextOptions.reducedMotion',
        };
      }
    }

    // --- RM-wrong-value: reducedMotion set to 'no-preference' → reject.
    //   Kills: an impl checking only for the KEY's presence, not its value.
    {
      const wrongValue = RM_GOOD.split("reducedMotion: 'reduce' } },").join(
        "reducedMotion: 'no-preference' } },",
      );
      const r = reducedMotionProjectIsWired(wrongValue);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            "RM-wrong-value: reducedMotionProjectIsWired should reject contextOptions.reducedMotion !== 'reduce'",
        };
      }
    }

    // --- RM-shorthand: the ADR-0219 D5 trap — `use: { reducedMotion: 'reduce' }`
    //   with NO contextOptions wrapper → reject, and the message must name the
    //   trap (ADR-0219 D5), not just "missing contextOptions", so an implementer
    //   who hits this from the ledger's own wording is steered to the fix rather
    //   than left to rediscover TS2769 independently.
    {
      const shorthand = RM_GOOD.split("use: { contextOptions: { reducedMotion: 'reduce' } },").join(
        "use: { reducedMotion: 'reduce' },",
      );
      const r = reducedMotionProjectIsWired(shorthand);
      if (r.ok || String(r.reason).indexOf('ADR-0219') === -1) {
        return {
          name,
          pass: false,
          detail: `RM-shorthand: reducedMotionProjectIsWired should reject the reducedMotion shorthand and name ADR-0219 D5, got ${JSON.stringify(r)}`,
        };
      }
    }

    // --- RM-hoisted-top: reducedMotion hoisted to the config-level `use:` block
    //   (merges into EVERY project, silently widening the whole e2e suite) →
    //   reject. Kills: an impl that only inspects project-scoped blocks and
    //   never checks the config-level `use:`.
    {
      const hoisted = RM_GOOD.split('use: { baseURL: e2eBaseUrl, headless: true },').join(
        "use: { baseURL: e2eBaseUrl, headless: true, reducedMotion: 'reduce' },",
      );
      const r = reducedMotionProjectIsWired(hoisted);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            'RM-hoisted-top: reducedMotionProjectIsWired should reject reducedMotion hoisted to the config-level use: block',
        };
      }
    }

    // --- RM-testIgnore-missing: the `default` project no longer excludes the new
    //   spec → reject. Kills: an impl that only checks the reduced-motion
    //   project's OWN testMatch and never checks the exclusion's other side.
    {
      const noIgnore = RM_GOOD.split(
        "{ name: 'default', testIgnore: 'reduced-motion.spec.ts' },",
      ).join("{ name: 'default' },");
      const r = reducedMotionProjectIsWired(noIgnore);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            "RM-testIgnore-missing: reducedMotionProjectIsWired should reject a 'default' project with no testIgnore",
        };
      }
    }

    // --- RM-testMatch-widened: the reduced-motion project's testMatch is widened
    //   to also collect a11y.spec.ts → reject (ADR-0219 D2). Kills: an impl that
    //   only checks testMatch NAMES the new spec and never checks that it names
    //   NOTHING ELSE.
    {
      const widened = RM_GOOD.split("testMatch: 'reduced-motion.spec.ts',").join(
        "testMatch: ['reduced-motion.spec.ts', 'a11y.spec.ts'],",
      );
      const r = reducedMotionProjectIsWired(widened);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            'RM-testMatch-widened: reducedMotionProjectIsWired should reject a testMatch that also names a11y.spec.ts',
        };
      }
    }

    // --- RM-testMatch-regex-widened: the SAME widening, spelled with RegExp literals
    //   and escaped dots → reject. `/a11y\\.spec\\.ts$/` contains no literal
    //   `a11y.spec.ts` substring yet collects exactly that file — MEASURED against the
    //   real Playwright collector at 2 files / 5 tests. The string-array fixture above
    //   does NOT cover this: it was green while this shape passed. Found by the artifact
    //   red-team pass, after the plan-phase pass and a 19-mutant bite-proof both missed it.
    {
      const rxWidened = RM_GOOD.split("testMatch: 'reduced-motion.spec.ts',").join(
        'testMatch: [/reduced-motion.spec.ts$/, /a11y\\.spec\\.ts$/],',
      );
      const r = reducedMotionProjectIsWired(rxWidened);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            'RM-testMatch-regex-widened: reducedMotionProjectIsWired should reject a RegExp testMatch whose escaped-dot spelling still collects a11y.spec.ts',
        };
      }
    }

    // --- RM-contextOptions-outside-use: `contextOptions` declared as a SIBLING of
    //   `use` rather than a member of it, injected by a spread so TypeScript's
    //   excess-property check does not fire → reject. Playwright only promotes
    //   `use.contextOptions` into `browser.newContext()`, so this config is a runtime
    //   NO-OP while `client-typecheck` stays clean. MEASURED green against the
    //   pre-fix predicate: nesting depth, not co-occurrence, is the criterion.
    {
      const sibling = RM_GOOD.split("use: { contextOptions: { reducedMotion: 'reduce' } },").join(
        "...({ contextOptions: { reducedMotion: 'reduce' } }),\n      use: {},",
      );
      const r = reducedMotionProjectIsWired(sibling);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            "RM-contextOptions-outside-use: reducedMotionProjectIsWired should reject a `contextOptions` that is not inside the project's own `use:` block (Playwright ignores it at runtime)",
        };
      }
    }

    // --- RM-decoy-projects-key: a SECOND `projects:` token planted in a string
    //   literal ahead of the real array → reject as AMBIGUOUS, never resolved to
    //   whichever came first. This repo has a measured history of first-hit
    //   anchors being steered by exactly this shape, and the decoy below is
    //   placed so that a bare `indexOf('projects:')` would walk to the DECOY's
    //   `[` and parse a hollow array that satisfies nothing — or, worse, one
    //   that satisfies everything.
    {
      const decoy = RM_GOOD.split("  testDir: './e2e',").join(
        "  testDir: './e2e',\n  metadata: { note: \"projects: [ { name: 'reduced-motion' } ]\" },",
      );
      const r = reducedMotionProjectIsWired(decoy);
      if (r.ok || String(r.reason).indexOf('MORE THAN ONE') === -1) {
        return {
          name,
          pass: false,
          detail: `RM-decoy-projects-key: a second \`projects:\` token outside comments must be rejected as ambiguous, got ${JSON.stringify(r)}`,
        };
      }
    }

    // --- RM-duplicate-project-name: two projects both named 'reduced-motion',
    //   the second hollow → reject. Kills: `blocks.find(...)`, which silently
    //   answers about the FIRST while Playwright runs both.
    {
      const dup = RM_GOOD.split('  ],\n});').join(
        "    { name: 'reduced-motion', testMatch: 'reduced-motion.spec.ts' },\n  ],\n});",
      );
      const r = reducedMotionProjectIsWired(dup);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            "RM-duplicate-project-name: two projects named 'reduced-motion' must be rejected as ambiguous",
        };
      }
    }

    // --- RM-comment-only: the whole projects array demoted to a `//` comment →
    //   reject. Kills: an impl that scans the RAW source, where a comment
    //   DESCRIBING the config is indistinguishable from the config.
    {
      const commented = RM_GOOD.split('\n')
        .map((l) => (l.trim() === '' || l.indexOf('projects:') === -1 ? l : `// ${l}`))
        .join('\n');
      const r = reducedMotionProjectIsWired(commented);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            'RM-comment-only: reducedMotionProjectIsWired should reject a `projects:` array that exists only inside a // comment',
        };
      }
    }
  }

  // =========================================================================
  // rb-20 (residual R-m23-s11-X11) PROOF-OF-TEETH — a11yHalf4IsFailClosed
  // =========================================================================
  {
    const RM4_GOOD_JUSTFILE = `a11y-e2e floor="169" axefloor="3" rmfloor="2": wasm
    set -euo pipefail
    case "{{floor}}" in
        ''|*[!0-9]*) echo "bad floor" >&2; exit 64;;
    esac
    case "{{axefloor}}" in
        ''|*[!0-9]*) echo "bad axefloor" >&2; exit 64;;
    esac
    case "{{rmfloor}}" in
        ''|*[!0-9]*) echo "a11y-e2e: rmfloor '{{rmfloor}}' is not a non-negative integer" >&2; exit 64;;
    esac
    rm -f /tmp/a11y-e2e-axe.json
    cd client && PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/a11y-e2e-axe.json npx playwright test e2e/a11y.spec.ts --reporter=json
    cd ..
    rm -f /tmp/a11y-e2e-rm.json
    cd client && PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/a11y-e2e-rm.json npx playwright test --project=reduced-motion --reporter=json
    cd ..
    node -e "const fs = require('node:fs'); const j = JSON.parse(fs.readFileSync('/tmp/a11y-e2e-rm.json', 'utf8')); const floor = Number(process.argv[1]); const s = j.stats; if (s.unexpected !== 0 || s.flaky !== 0 || s.skipped !== 0) { console.error('rm tier unexpected=' + s.unexpected + ' flaky=' + s.flaky + ' skipped=' + s.skipped); process.exit(1) } if (s.expected < floor) { console.error('rm tier reported ' + s.expected + ' test(s), floor ' + floor); process.exit(1) } console.log('A11Y-RM OK tests=' + s.expected)" -- "{{rmfloor}}"
`;

    // --- RM4-good: the healthy shape → accept.
    {
      const r = a11yHalf4IsFailClosed(RM4_GOOD_JUSTFILE);
      if (!r.ok) {
        return {
          name,
          pass: false,
          detail: `RM4-good: a11yHalf4IsFailClosed should accept the healthy shape but rejected: ${r.reason}`,
        };
      }
    }

    // --- RM4-absent: half 4 (--project=reduced-motion) entirely absent → reject.
    //   Kills: an impl that is satisfied by the rmfloor parameter alone, without
    //   checking that a run actually uses it.
    {
      const absent = RM4_GOOD_JUSTFILE.split(
        'rm -f /tmp/a11y-e2e-rm.json\n    cd client && PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/a11y-e2e-rm.json npx playwright test --project=reduced-motion --reporter=json\n    cd ..\n    ',
      ).join('');
      const r = a11yHalf4IsFailClosed(absent);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            'RM4-absent: a11yHalf4IsFailClosed should reject a recipe with no --project=reduced-motion invocation',
        };
      }
    }

    // --- RM4-no-project-flag: half 4 is present and its floor is asserted, but
    //   `--project=reduced-motion` is dropped from the invocation, so the run
    //   collects every e2e spec instead of the two-test project → reject.
    {
      const noFlag = RM4_GOOD_JUSTFILE.split(' --project=reduced-motion').join('');
      const r = a11yHalf4IsFailClosed(noFlag);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            'RM4-no-project-flag: a11yHalf4IsFailClosed should reject half 4 running without --project=reduced-motion',
        };
      }
    }

    // --- RM4-reused-path: half 4 writes to half 3's report path instead of its
    //   own → reject. Kills: an impl that only checks --project is present and
    //   never checks the report path is DISTINCT.
    {
      const reused =
        RM4_GOOD_JUSTFILE.split('/tmp/a11y-e2e-rm.json').join('/tmp/a11y-e2e-axe.json');
      const r = a11yHalf4IsFailClosed(reused);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            "RM4-reused-path: a11yHalf4IsFailClosed should reject half 4 reusing half 3's report path",
        };
      }
    }

    // --- RM4-write-only: the report is written but never read back (the `node -e`
    //   floor block deleted, and with it the second occurrence of the path) →
    //   reject with the OCCURRENCE reason specifically. Kills: an impl satisfied
    //   by one mention of the path — a report nobody reads.
    {
      const cut = RM4_GOOD_JUSTFILE.indexOf('\n    node -e');
      if (cut === -1) {
        return {
          name,
          pass: false,
          detail:
            'RM4-write-only: fixture construction failed — RM4_GOOD_JUSTFILE no longer contains a `node -e` floor block, so this tooth would be vacuous',
        };
      }
      const writeOnly = `${RM4_GOOD_JUSTFILE.slice(0, cut)}\n`
        .split('    rm -f /tmp/a11y-e2e-rm.json\n')
        .join('');
      const r = a11yHalf4IsFailClosed(writeOnly);
      if (r.ok || String(r.reason).indexOf('appears only 1 time(s)') === -1) {
        return {
          name,
          pass: false,
          detail: `RM4-write-only: a half 4 whose report is written but never read back must be rejected for that reason, got ${JSON.stringify(r)}`,
        };
      }
    }

    // --- RM4-no-floor-assert: the floor comparison (`s.expected < floor`) is
    //   deleted; only the unexpected/flaky/skipped guard remains → reject.
    //   Kills: an impl satisfied by the presence of a skipped guard alone.
    {
      const noFloor = RM4_GOOD_JUSTFILE.split(
        "if (s.expected < floor) { console.error('rm tier reported ' + s.expected + ' test(s), floor ' + floor); process.exit(1) } ",
      ).join('');
      // NOT vacuous, and this is the subtle part: `noFloor` STILL contains the
      // substring `.expected`, inside the surviving
      // `console.log('A11Y-RM OK tests=' + s.expected)`. A presence test for
      // `.expected` accepts this mutant; only the COMPARISON test rejects it.
      // The reason is pinned so the tooth cannot silently start passing because
      // some earlier clause fired instead.
      if (noFloor.indexOf('.expected') === -1) {
        return {
          name,
          pass: false,
          detail:
            'RM4-no-floor-assert: fixture construction failed — the mutant no longer contains `.expected` at all, which would make this tooth prove nothing about comparison-vs-presence',
        };
      }
      const r = a11yHalf4IsFailClosed(noFloor);
      if (r.ok || String(r.reason).indexOf('never COMPARES') === -1) {
        return {
          name,
          pass: false,
          detail: `RM4-no-floor-assert: a recipe that reports .expected but never compares it against a floor must be rejected for that reason, got ${JSON.stringify(r)}`,
        };
      }
    }

    // --- RM4-no-skipped-guard: the `s.skipped !== 0` clause is dropped → reject.
    //   Kills: an impl that accepts unexpected/flaky alone. A wholly
    //   describe.skip-ed spec file is the REAL silent zero here (ADR-0219 D4);
    //   the missing-file shape half 3's comment names exits 1 on 1.61.1.
    {
      const noSkipped = RM4_GOOD_JUSTFILE.split(' || s.skipped !== 0').join('');
      // NOT vacuous, and this is the subtle part (MEASURED against the real
      // recipe, where a token-presence version of this clause SURVIVED this exact
      // mutation): `noSkipped` still contains the word `skipped` twice, inside
      // the surviving `console.error('... skipped=' + s.skipped)`. Only a
      // COMPARISON test rejects it.
      if (noSkipped.indexOf('skipped') === -1) {
        return {
          name,
          pass: false,
          detail:
            'RM4-no-skipped-guard: fixture construction failed — the mutant no longer mentions `skipped` at all, which would make this tooth prove nothing about comparison-vs-presence',
        };
      }
      const r = a11yHalf4IsFailClosed(noSkipped);
      if (r.ok || String(r.reason).indexOf('never BRANCHES') === -1) {
        return {
          name,
          pass: false,
          detail: `RM4-no-skipped-guard: a recipe that PRINTS the skip count but never branches on it must be rejected for that reason, got ${JSON.stringify(r)}`,
        };
      }
    }

    // --- RM4-no-case-guard: the `case "{{rmfloor}}" in ...` block is deleted from
    //   the body, but `{{rmfloor}}` is still passed to the run (a malformed
    //   rmfloor would then reach `Number('')` unguarded) → reject. Kills: an impl
    //   satisfied by the mere PRESENCE of an `rmfloor=` parameter, without
    //   checking it is validated before use (ADR-0183 D7).
    {
      const noCaseGuard = RM4_GOOD_JUSTFILE.split(
        'case "{{rmfloor}}" in\n        \'\'|*[!0-9]*) echo "a11y-e2e: rmfloor \'{{rmfloor}}\' is not a non-negative integer" >&2; exit 64;;\n    esac\n    ',
      ).join('');
      const r = a11yHalf4IsFailClosed(noCaseGuard);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            'RM4-no-case-guard: a11yHalf4IsFailClosed should reject a recipe whose rmfloor parameter is never case-guarded',
        };
      }
    }

    // --- RM4-hollow-case-guard: the `case` header survives but its
    //   `''|*[!0-9]*)` arm is replaced by a catch-all that validates nothing →
    //   reject. Kills: an impl that checks only for the case HEADER.
    {
      const hollow = RM4_GOOD_JUSTFILE.split(
        "''|*[!0-9]*) echo \"a11y-e2e: rmfloor '{{rmfloor}}' is not a non-negative integer\" >&2; exit 64;;",
      ).join('*) : ;;');
      const r = a11yHalf4IsFailClosed(hollow);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            'RM4-hollow-case-guard: a11yHalf4IsFailClosed should reject a `case "{{rmfloor}}" in` whose only arm validates nothing',
        };
      }
    }

    // --- RM4-decoy-case-guard: a SECOND, healthy-looking `case "{{rmfloor}}" in`
    //   guard planted late in the body while the real one is hollowed → reject
    //   as ambiguous. Kills the first-hit anchor: a predicate that resolves the
    //   case header with `indexOf` and then scans forward can be steered onto
    //   whichever copy looks good.
    {
      const decoy = `${RM4_GOOD_JUSTFILE}    case "{{rmfloor}}" in\n        ''|*[!0-9]*) echo "decoy" >&2; exit 64;;\n    esac\n`;
      const r = a11yHalf4IsFailClosed(decoy);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            'RM4-decoy-case-guard: a11yHalf4IsFailClosed should reject two `case "{{rmfloor}}" in` guard headers as ambiguous',
        };
      }
    }

    // --- RM4-no-rmfloor-param: the body is perfect but the recipe HEADER never
    //   declares `rmfloor=`, so `{{rmfloor}}` is not a parameter at all → reject.
    //   Also pins the header anchor: the first `a11y-e2e ` substring in this
    //   fixture is deliberately a PROSE COMMENT above the header, mirroring the
    //   real justfile, so a predicate anchored on `indexOf('a11y-e2e ')` starts
    //   in the wrong place.
    {
      const proseAbove = `# The nightly a11y-e2e job provisions a browser and a server.\n${RM4_GOOD_JUSTFILE.split('a11y-e2e floor="169" axefloor="3" rmfloor="2": wasm').join('a11y-e2e floor="169" axefloor="3": wasm')}`;
      const r = a11yHalf4IsFailClosed(proseAbove);
      if (r.ok || String(r.reason).indexOf('rmfloor=') === -1) {
        return {
          name,
          pass: false,
          detail: `RM4-no-rmfloor-param: a11yHalf4IsFailClosed should reject a header with no rmfloor= parameter (and must anchor on the real header line, not the first prose mention), got ${JSON.stringify(r)}`,
        };
      }
    }

    // --- RM4-console-reporter: `--reporter=json` swapped for a console reporter,
    //   so the report the floor is read from is never written → reject (RM-5).
    {
      const consoleReporter = RM4_GOOD_JUSTFILE.split(
        'npx playwright test --project=reduced-motion --reporter=json',
      ).join('npx playwright test --project=reduced-motion --reporter=list');
      const r = a11yHalf4IsFailClosed(consoleReporter);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            'RM4-console-reporter: a11yHalf4IsFailClosed should reject half 4 running without --reporter=json',
        };
      }
    }

    // --- RM4-floor-not-passed: the recipe declares `rmfloor`, case-guards it, and
    //   compares `.expected` against a floor — but the parameter is never passed
    //   to the checker, so the comparison is against a value the header cannot
    //   influence → reject. Kills: an impl that treats "the parameter exists and
    //   is guarded" as "the parameter is used".
    {
      const notPassed = RM4_GOOD_JUSTFILE.split(' -- "{{rmfloor}}"').join('');
      const r = a11yHalf4IsFailClosed(notPassed);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            'RM4-floor-not-passed: a11yHalf4IsFailClosed should reject a half 4 that never passes `{{rmfloor}}` to its floor checker',
        };
      }
    }

    // --- RM4-header-anchor-control: the SAME prose comment above an otherwise
    //   HEALTHY recipe must still be ACCEPTED. Without this control the tooth
    //   above passes for the wrong reason (a predicate that rejects everything
    //   with prose above it would satisfy it).
    {
      const proseAboveGood = `# The nightly a11y-e2e job provisions a browser and a server.\n${RM4_GOOD_JUSTFILE}`;
      const r = a11yHalf4IsFailClosed(proseAboveGood);
      if (!r.ok) {
        return {
          name,
          pass: false,
          detail: `RM4-header-anchor-control: a11yHalf4IsFailClosed rejected a healthy recipe carrying a prose 'a11y-e2e ' mention above its header: ${r.reason}`,
        };
      }
    }
  }

  // =========================================================================
  // rb-20 (RM-4) PROOF-OF-TEETH — the nightly failure-evidence artifact clause
  // added to a11yNightlyJobIsWired. Nothing gated this `path:` list before
  // rb-20, and the verbatim job pin cannot cover it: the pin agrees with
  // whatever it was legitimately regenerated from, which is exactly the moment
  // a forgotten report path slips through.
  // =========================================================================
  {
    const RMN_LIST = `          path: |
            /tmp/a11y-e2e-vitest.json
            /tmp/a11y-e2e-axe.json
            /tmp/a11y-e2e-rm.json
`;

    // --- RMN-artifact-missing-half4: the list exists and is non-empty, but half
    //   4's report is not on it → reject, naming the path. Kills: an impl that
    //   is satisfied by the mere PRESENCE of an upload-artifact step.
    {
      const missing = A11Y_NIGHTLY_MINIMAL_GOOD.split(RMN_LIST).join(
        `          path: |
            /tmp/a11y-e2e-vitest.json
            /tmp/a11y-e2e-axe.json
`,
      );
      if (missing === A11Y_NIGHTLY_MINIMAL_GOOD) {
        return {
          name,
          pass: false,
          detail:
            'RMN-artifact-missing-half4: fixture construction failed — A11Y_NIGHTLY_MINIMAL_GOOD no longer carries the expected `path: |` list, so this tooth would be vacuous',
        };
      }
      const r = a11yNightlyJobIsWired(missing);
      if (r.ok || String(r.reason).indexOf('/tmp/a11y-e2e-rm.json') === -1) {
        return {
          name,
          pass: false,
          detail: `RMN-artifact-missing-half4: a failure-evidence artifact that omits half 4's report must be rejected for that reason, got ${JSON.stringify(r)}`,
        };
      }
    }

    // --- RMN-artifact-comment-only: half 4's report appears in the list ONLY as
    //   a `#` comment line → reject. Kills: a raw substring scan of the job
    //   block, which cannot tell an uploaded path from a described one.
    {
      const commented = A11Y_NIGHTLY_MINIMAL_GOOD.split('            /tmp/a11y-e2e-rm.json\n').join(
        '            # /tmp/a11y-e2e-rm.json\n',
      );
      const r = a11yNightlyJobIsWired(commented);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            'RMN-artifact-comment-only: a11yNightlyJobIsWired accepted a job whose half-4 report path exists only as a # comment inside the path list',
        };
      }
    }

    // --- RMN-artifact-absent: the upload-artifact step is deleted outright →
    //   reject. Kills: an impl that only inspects a list it happens to find.
    {
      const noUpload = A11Y_NIGHTLY_MINIMAL_GOOD.slice(
        0,
        A11Y_NIGHTLY_MINIMAL_GOOD.indexOf(
          '      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4\n',
        ),
      );
      const r = a11yNightlyJobIsWired(noUpload);
      if (r.ok) {
        return {
          name,
          pass: false,
          detail:
            'RMN-artifact-absent: a11yNightlyJobIsWired accepted an a11y-e2e job with no upload-artifact step at all',
        };
      }
    }

    // --- RMN-artifact-inline-scalar CONTROL: the OTHER legal YAML spelling —
    //   `path: /tmp/a11y-e2e-rm.json` as an inline scalar rather than a `|`
    //   block — must be ACCEPTED. Without this control the clause could be
    //   satisfied by a parser that only understands block lists, and rewriting
    //   the real workflow into the scalar form would red it for no reason.
    {
      const scalar = A11Y_NIGHTLY_MINIMAL_GOOD.split(RMN_LIST).join(
        '          path: /tmp/a11y-e2e-rm.json\n',
      );
      const r = a11yNightlyJobIsWired(scalar);
      if (!r.ok) {
        return {
          name,
          pass: false,
          detail: `RMN-artifact-inline-scalar: a11yNightlyJobIsWired rejected the inline-scalar spelling of the same path list: ${r.reason}`,
        };
      }
    }
  }

  // =========================================================================
  // REAL FILE CHECKS
  // =========================================================================
  const root = path.resolve('.');
  const ciPath = path.join(root, '.github/workflows/ci.yml');
  const justfilePath = path.join(root, 'justfile');
  const lefthookPath = path.join(root, 'lefthook.yml');
  const runMjsPath = path.join(root, 'evals/run.mjs');
  const nightlyPath = path.join(root, '.github/workflows/nightly.yml');
  // rb-20 (RM-1 / RM-2): the reduced-motion Playwright PROJECT lives here.
  const playwrightConfigPath = path.join(root, 'client/playwright.config.ts');

  let ciYaml, justfile, lefthook, runMjs, nightlyYaml, playwrightConfig;

  try {
    ciYaml = readFileSync(ciPath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read .github/workflows/ci.yml' };
  }

  try {
    justfile = readFileSync(justfilePath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read justfile' };
  }

  try {
    lefthook = readFileSync(lefthookPath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read lefthook.yml' };
  }

  try {
    runMjs = readFileSync(runMjsPath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read evals/run.mjs' };
  }

  try {
    nightlyYaml = readFileSync(nightlyPath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read .github/workflows/nightly.yml' };
  }

  try {
    playwrightConfig = readFileSync(playwrightConfigPath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read client/playwright.config.ts' };
  }

  // Self-structural check: this file must contain the main-guard.
  let selfSrc;
  try {
    selfSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read own source for main-guard structural check' };
  }
  if (!selfContainsMainGuard(selfSrc)) {
    return {
      name,
      pass: false,
      detail:
        'self-structural check FAIL: this file is missing the main-guard (process.argv[1] / fileURLToPath / process.exit) — the anchor cannot silently become a no-op import',
    };
  }

  // Check 1: ciStepsUnneutered
  {
    let r;
    try {
      r = ciStepsUnneutered(ciYaml);
    } catch (e) {
      return { name, pass: false, detail: `ciStepsUnneutered threw on real ci.yml — ${e.message}` };
    }
    if (!r.ok) {
      return { name, pass: false, detail: `ciStepsUnneutered FAIL on real ci.yml: ${r.reason}` };
    }
  }

  // Check 2: justfileCiDepsAppearInCi
  {
    let r;
    try {
      r = justfileCiDepsAppearInCi(justfile, ciYaml);
    } catch (e) {
      return { name, pass: false, detail: `justfileCiDepsAppearInCi threw — ${e.message}` };
    }
    if (!r.ok) {
      return { name, pass: false, detail: `justfileCiDepsAppearInCi FAIL: ${r.reason}` };
    }
  }

  // Check 3: ciRecipeBodiesIntact
  {
    let r;
    try {
      r = ciRecipeBodiesIntact(justfile);
    } catch (e) {
      return { name, pass: false, detail: `ciRecipeBodiesIntact threw — ${e.message}` };
    }
    if (!r.ok) {
      return { name, pass: false, detail: `ciRecipeBodiesIntact FAIL: ${r.reason}` };
    }
  }

  // Check 4: runMjsIsIntact
  {
    let r;
    try {
      r = runMjsIsIntact(runMjs);
    } catch (e) {
      return { name, pass: false, detail: `runMjsIsIntact threw — ${e.message}` };
    }
    if (!r.ok) {
      return { name, pass: false, detail: `runMjsIsIntact FAIL: ${r.reason}` };
    }
  }

  // Check 5: anchorIsWired
  // EXPECTED RED: lefthook.yml does not yet contain `node evals/ci-gate-wiring.eval.mjs`
  // and the e2e job does not yet have `- run: node evals/ci-gate-wiring.eval.mjs`.
  // GREEN edit: (1) add `node evals/ci-gate-wiring.eval.mjs` under a lefthook.yml
  // pre-push command; (2) add `- run: node evals/ci-gate-wiring.eval.mjs` inside
  // the `e2e:` job in .github/workflows/ci.yml.
  {
    let r;
    try {
      r = anchorIsWired(lefthook, ciYaml);
    } catch (e) {
      return { name, pass: false, detail: `anchorIsWired threw — ${e.message}` };
    }
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `anchorIsWired FAIL (EXPECTED RED — implementer must wire the anchor): ${r.reason}`,
      };
    }
  }

  // Check 6: a11yRecipeBodyIntact
  {
    let r;
    try {
      r = a11yRecipeBodyIntact(justfile);
    } catch (e) {
      return { name, pass: false, detail: `a11yRecipeBodyIntact threw — ${e.message}` };
    }
    if (!r.ok) {
      return { name, pass: false, detail: `a11yRecipeBodyIntact FAIL: ${r.reason}` };
    }
  }

  // Check 7: a11yNightlyJobIsWired
  {
    let r;
    try {
      r = a11yNightlyJobIsWired(nightlyYaml);
    } catch (e) {
      return { name, pass: false, detail: `a11yNightlyJobIsWired threw — ${e.message}` };
    }
    if (!r.ok) {
      return { name, pass: false, detail: `a11yNightlyJobIsWired FAIL: ${r.reason}` };
    }
  }

  // Check 8: a11yRecipeBodyIsPinned (m23-s11 round 2 — the red-team-proven bypass of Check 6).
  {
    let r;
    try {
      r = a11yRecipeBodyIsPinned(justfile);
    } catch (e) {
      return { name, pass: false, detail: `a11yRecipeBodyIsPinned threw — ${e.message}` };
    }
    if (!r.ok) {
      return { name, pass: false, detail: `a11yRecipeBodyIsPinned FAIL: ${r.reason}` };
    }
  }
  // Check 9: a11ySpecUsesAxe (rb-19) — the PAYLOAD gate.
  // A missing client/e2e/a11y.spec.ts must FAIL here and must never read as a skip:
  // "the file we were told to gate is absent" is the single most important thing
  // this eval can say about the axe tier. (Before rb-19 shipped the spec, this was
  // the check that produced the ADR-0010 RED-before state.)
  {
    let specText;
    try {
      specText = readFileSync(path.join(root, 'client/e2e/a11y.spec.ts'), 'utf8');
    } catch {
      return {
        name,
        pass: false,
        detail:
          'cannot read client/e2e/a11y.spec.ts (EXPECTED RED — rb-19 implementer must author the axe-core + real-browser spec that m23-s11 deferred, ledger X10/X11). A missing spec is a FAIL, never a skip.',
      };
    }
    let r;
    try {
      r = a11ySpecUsesAxe(specText);
    } catch (e) {
      return { name, pass: false, detail: `a11ySpecUsesAxe threw — ${e.message}` };
    }
    if (!r.ok) {
      return { name, pass: false, detail: `a11ySpecUsesAxe FAIL: ${r.reason}` };
    }
  }

  // Check 10: clientDeclaresAxeDep (rb-19). GREEN on the committed tree the moment
  // the predicate exists — a ratchet against removing the dependency, loosening the
  // pin to a range, or letting package.json and the lockfile drift apart.
  {
    let pkgJson;
    let lockText;
    try {
      pkgJson = readFileSync(path.join(root, 'client/package.json'), 'utf8');
    } catch {
      return { name, pass: false, detail: 'cannot read client/package.json' };
    }
    try {
      lockText = readFileSync(path.join(root, 'client/package-lock.json'), 'utf8');
    } catch {
      return { name, pass: false, detail: 'cannot read client/package-lock.json' };
    }
    let r;
    try {
      r = clientDeclaresAxeDep(pkgJson, lockText);
    } catch (e) {
      return { name, pass: false, detail: `clientDeclaresAxeDep threw — ${e.message}` };
    }
    if (!r.ok) {
      return { name, pass: false, detail: `clientDeclaresAxeDep FAIL: ${r.reason}` };
    }
  }

  // Check 11: a11yNightlyJobIsPinned (rb-19). A red here means the a11y-e2e job
  // block moved without A11Y_E2E_NIGHTLY_JOB_BLOCK being re-derived in the same
  // commit. That is the intended behaviour, not a bug to route around: the pin is
  // the only thing that sees a step inserted AHEAD of the gate.
  {
    let r;
    try {
      r = a11yNightlyJobIsPinned(nightlyYaml);
    } catch (e) {
      return { name, pass: false, detail: `a11yNightlyJobIsPinned threw — ${e.message}` };
    }
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `a11yNightlyJobIsPinned FAIL: ${r.reason}`,
      };
    }
  }

  // Check 12: a11yNightlyJobHasAxePrereqs (rb-19). The token twin of Check 11: it is
  // what still holds AFTER the verbatim pin is legitimately regenerated, when the
  // pin necessarily agrees with whatever it was regenerated from.
  {
    let r;
    try {
      r = a11yNightlyJobHasAxePrereqs(nightlyYaml);
    } catch (e) {
      return { name, pass: false, detail: `a11yNightlyJobHasAxePrereqs threw — ${e.message}` };
    }
    if (!r.ok) {
      return { name, pass: false, detail: `a11yNightlyJobHasAxePrereqs FAIL: ${r.reason}` };
    }
  }

  // Check 13: a11yStaysNightlyOnly (rb-19) — spec §5.7 deliverable (3). The only
  // check here that fails when the axe tier is wired TOO WELL.
  {
    let r;
    try {
      r = a11yStaysNightlyOnly(justfile, ciYaml);
    } catch (e) {
      return { name, pass: false, detail: `a11yStaysNightlyOnly threw — ${e.message}` };
    }
    if (!r.ok) {
      return { name, pass: false, detail: `a11yStaysNightlyOnly FAIL: ${r.reason}` };
    }
  }

  // Check 14: reducedMotionProjectIsWired (rb-20, RM-1/RM-2). The config side of
  // the reduced-motion browser tier: a dedicated `reduced-motion` project spelled
  // `use: { contextOptions: { reducedMotion: 'reduce' } }` (ADR-0219 D5), with the
  // collection boundary closed on BOTH sides (ADR-0219 D2).
  {
    let r;
    try {
      r = reducedMotionProjectIsWired(playwrightConfig);
    } catch (e) {
      return { name, pass: false, detail: `reducedMotionProjectIsWired threw — ${e.message}` };
    }
    if (!r.ok) {
      return { name, pass: false, detail: `reducedMotionProjectIsWired FAIL: ${r.reason}` };
    }
  }

  // Check 15: a11yHalf4IsFailClosed (rb-20, RM-4). The recipe side: half 4 of
  // `just a11y-e2e` runs the reduced-motion project alone, writes its OWN JSON
  // report, and floors it from that report with a skipped guard and a
  // case-guarded `rmfloor`.
  {
    let r;
    try {
      r = a11yHalf4IsFailClosed(justfile);
    } catch (e) {
      return { name, pass: false, detail: `a11yHalf4IsFailClosed threw — ${e.message}` };
    }
    if (!r.ok) {
      return { name, pass: false, detail: `a11yHalf4IsFailClosed FAIL: ${r.reason}` };
    }
  }

  return {
    name,
    pass: true,
    detail:
      'all 15 ci-gate-wiring checks pass: ci steps unneutered (all 7 exact verbs, no if:/coe), justfile/ci.yml dep parity, recipe bodies intact, run.mjs structural invariants, anchor wired in lefthook + e2e job, a11y-e2e recipe body intact, a11y-e2e nightly job wired, a11y-e2e recipe region matches its verbatim pin, plus a11y axe tier wired (spec + dep + recipe half 3 + nightly job pin) and staying nightly-only, plus the rb-20 reduced-motion Playwright project (config side) and half 4 of a11y-e2e (recipe side)',
  };
}

// ---------------------------------------------------------------------------
// Main-guard: run directly (`node evals/ci-gate-wiring.eval.mjs`) to execute
// the eval standalone — used by the e2e-job anchor so it runs without being
// evaluated through `just eval` (breaking the self-sealing circularity).
// Calls ciGateWiringEval() directly (NOT via dynamic self-import, which
// deadlocks: the module cannot settle its own top-level await while importing
// itself during evaluation).
// Marker tokens checked by selfContainsMainGuard: process.argv[1],
// fileURLToPath(import.meta.url), ciGateWiringEval, process.exit(result.pass ? 0 : 1).
// ---------------------------------------------------------------------------
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const result = await (async () => {
    try {
      return await ciGateWiringEval();
    } catch (e) {
      return { name: 'ci-gate-wiring', pass: false, detail: `threw: ${e?.message ?? String(e)}` };
    }
  })();
  console.log(
    `eval ${result.pass ? 'PASS' : 'FAIL'}: ${result.name}${result.detail ? ` — ${result.detail}` : ''}`,
  );
  process.exit(result.pass ? 0 : 1);
}
