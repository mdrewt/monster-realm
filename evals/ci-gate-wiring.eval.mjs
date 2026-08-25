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

// The exact, UNSUFFIXED step line the nightly job must carry.
const A11Y_NIGHTLY_STEP = '- run: just a11y-e2e';

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
  return {
    ok: true,
    reason: `justfile a11y-e2e: body is fail-closed and pins ${A11Y_EVAL_FILES.length} a11y eval(s) plus ${A11Y_PINNED_SPEC}`,
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
  "a11y-e2e floor=\"169\": wasm\n    #!/usr/bin/env bash\n    set -euo pipefail\n    # Fail loud on a non-integer floor BEFORE the run: a malformed value would\n    # otherwise make `[ -gt ]` error inside the if-condition below and silently\n    # skip the ratchet (vacuous green). `[ \"\" -gt N ]` in an if-condition is\n    # set -e-EXEMPT \u2014 the measured false-green shape in this justfile (ADR-0183\n    # D7, and the same guard mutate-server carries).\n    case \"{{floor}}\" in\n        ''|*[!0-9]*) echo \"a11y-e2e: floor '{{floor}}' is not a non-negative integer\" >&2; exit 64;;\n    esac\n    # --- Half 1: the a11y eval roster, pinned BY NAME. A deleted or renamed\n    # eval makes import() throw, which set -e turns into a non-zero exit.\n    # `node evals/<x>.eval.mjs` alone exits 0 VACUOUSLY (these three carry no\n    # main guard, by design: a main guard truncates run.mjs mid-loop at exit 0),\n    # so the default export must be imported and called.\n    a11y_eval_check() {\n        node -e \"import(process.argv[1]).then(m => m.default()).then(r => { if (!r.pass) { console.error('a11y eval FAIL: ' + r.name + ' \u2014 ' + r.detail); process.exit(1) } const m = /teeth=(\\\\d+)\\\\/(\\\\d+)/.exec(String(r.detail)); if (m === null) { console.error('a11y eval reports NO teeth tally: ' + r.name + ' \u2014 an eval that runs no inline fixtures proves nothing, and a body gutted to a bare pass:true looks identical to a real one'); process.exit(1) } if (m[1] !== m[2] || Number(m[1]) < 1) { console.error('a11y eval teeth uneven or empty: ' + r.name + ' \u2014 ' + m[0]); process.exit(1) } console.log('  teeth ' + m[0]) })\" -- \"$1\"\n        echo \"a11y eval OK: $1\"\n    }\n    a11y_eval_check ./evals/overlay-a11y-manifest.eval.mjs\n    a11y_eval_check ./evals/a11y-static-shell.eval.mjs\n    a11y_eval_check ./evals/reduced-motion-purity.eval.mjs\n    # --- Half 2: floor the a11y unit tier. Delete the stale report first: a\n    # leftover report from a previous run would be read as this run's result if\n    # vitest died before writing (measured shape).\n    rm -f /tmp/a11y-e2e-vitest.json\n    cd client && npx vitest run --reporter=json --outputFile=/tmp/a11y-e2e-vitest.json \\\n        src/ui/overlayA11yWiring.test.ts \\\n        src/ui/overlayA11y.test.ts \\\n        src/ui/focusTrap.test.ts \\\n        src/ui/liveRegion.test.ts \\\n        src/ui/announcements.test.ts \\\n        src/ui/a11yCopy.test.ts \\\n        src/main.a11yFocus.test.ts \\\n        src/render/motionPreference.test.ts\n    cd ..\n    node -e \"const fs = require('node:fs'); let j; try { j = JSON.parse(fs.readFileSync('/tmp/a11y-e2e-vitest.json', 'utf8')) } catch (e) { console.error('a11y-e2e: vitest wrote no readable JSON report \u2014 ' + e.message); process.exit(1) } const floor = Number(process.argv[1]); const files = j.testResults.length; const total = j.numTotalTests; if (files !== 8) { console.error('a11y-e2e: ' + files + ' spec file(s) reported, expected 8 \u2014 an a11y spec file was deleted or renamed'); process.exit(1) } if (j.numFailedTests !== 0 || j.numPendingTests !== 0 || j.numTodoTests !== 0) { console.error('a11y-e2e: failed=' + j.numFailedTests + ' pending=' + j.numPendingTests + ' todo=' + j.numTodoTests + ' \u2014 a skipped a11y test is a silently ungated one'); process.exit(1) } if (total < floor) { console.error('a11y-e2e: a11y unit tier reported ' + total + ' test(s) across ' + files + ' file(s) \u2014 floor is ' + floor); process.exit(1) } console.log('A11Y-NIGHTLY OK evals=3/3 files=' + files + ' tests=' + total + ' floor=' + floor + ' f=0 pend=0 todo=0')\" -- \"{{floor}}\"\n    echo \"DEFERRED: axe-core + real-browser tier is NOT run here (m23-s11 ledger X10/X11).\"\n    echo \"DEFERRED: A11Y-32 / A11Y-33 are MANUAL and are NEVER CI-green \u2014 docs/a11y-manual-protocol.md\"\n";

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

  return {
    ok: true,
    reason:
      'nightly.yml declares an a11y-e2e job that invokes `just a11y-e2e` exactly once, is schedulable (ubuntu-latest, no matrix), and is unneutered at both the job and the step level',
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
          path: /tmp/a11y-vitest.json
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
      `name: Nightly\non:\n  workflow_dispatch:\njobs:\n  a11y-e2e:\n    runs-on: ubuntu-latest\n    steps:\n      - run: just a11y-e2e\n        continue-on-error: ${coe}\n`;
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
  // REAL FILE CHECKS
  // =========================================================================
  const root = path.resolve('.');
  const ciPath = path.join(root, '.github/workflows/ci.yml');
  const justfilePath = path.join(root, 'justfile');
  const lefthookPath = path.join(root, 'lefthook.yml');
  const runMjsPath = path.join(root, 'evals/run.mjs');
  const nightlyPath = path.join(root, '.github/workflows/nightly.yml');

  let ciYaml, justfile, lefthook, runMjs, nightlyYaml;

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

  return {
    name,
    pass: true,
    detail:
      'all 8 ci-gate-wiring checks pass: ci steps unneutered (all 7 exact verbs, no if:/coe), justfile/ci.yml dep parity, recipe bodies intact, run.mjs structural invariants, anchor wired in lefthook + e2e job, a11y-e2e recipe body intact, a11y-e2e nightly job wired, a11y-e2e recipe region matches its verbatim pin',
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
