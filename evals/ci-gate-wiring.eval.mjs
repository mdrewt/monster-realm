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
const REQUIRED_JUST_STEPS = [
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

  // =========================================================================
  // REAL FILE CHECKS
  // =========================================================================
  const root = path.resolve('.');
  const ciPath = path.join(root, '.github/workflows/ci.yml');
  const justfilePath = path.join(root, 'justfile');
  const lefthookPath = path.join(root, 'lefthook.yml');
  const runMjsPath = path.join(root, 'evals/run.mjs');

  let ciYaml, justfile, lefthook, runMjs;

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

  return {
    name,
    pass: true,
    detail:
      'all 5 ci-gate-wiring checks pass: ci steps unneutered (all 7 exact verbs, no if:/coe), justfile/ci.yml dep parity, recipe bodies intact, run.mjs structural invariants, anchor wired in lefthook + e2e job',
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
