// Nightly republish smoke-test wiring eval (ADR-0079 / spec §12.5b-6).
// Extended in m13.5a (EARS 13.5a-2 + guard-side of 13.5a-6) to also verify:
//   - mutation job exists and is not neutered
//   - coverage job exists and is not neutered
//   - mutation-server job exists (ADR-0050 amendment) and is not neutered
//   - nightly triggers on schedule + workflow_dispatch (not just push)
//   - coverage recipe threshold ≥ 96 (not the placeholder =25)
//   - mutate-server recipe is intact (missed.txt, no scope narrowing, cap ≤ 340)
//
// EXPECTED REAL-TREE STATE AT RED (m13.5a additions only):
//   nightlyHasServerMutationJob → FAIL (mutation-server job absent from nightly.yml)
//   mutateServerRecipeIntact    → FAIL (mutate-server recipe absent from justfile)
//   coverageRecipeThresholdIntact → FAIL (threshold still =25 in justfile)
// All pre-existing checks (smoke-republish wiring) remain GREEN.
//
// Verifies that the nightly publish→republish→sync_content smoke test is
// correctly wired: job lives in nightly.yml (not ci.yml), the smoke script
// is referenced, the justfile recipe exists, the script file is present, and
// the failure policy is documented in ADR-0079.
//
// Proof-of-teeth: TEETH A–E run against known-bad inline fixtures BEFORE the
// real files are checked; any tooth that fails to bite fails the eval itself.
//
// IMPORTANT: NO new RegExp(...) — use only literal regex literals or String
// methods (detect-non-literal-regexp Semgrep rule has bitten this project 3×).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { extractJobBlock } from './e2e-desync-teeth.eval.mjs';

// ---------------------------------------------------------------------------
// Pure predicate: nightly.yml has a `smoke-republish:` job at the 2-space
// job-key indent level inside a `jobs:` block.
// ---------------------------------------------------------------------------
export function nightlyHasSmokeRepublishJob(yaml) {
  // Match "  smoke-republish:" at the start of a line (2-space indent = job key).
  // \s matches \n so the OR branch is redundant — removed.
  return /\n {2}smoke-republish:\s/.test(yaml);
}

// ---------------------------------------------------------------------------
// Pure predicate: the nightly YAML invokes the smoke test via a `run:` step —
// either `run: just smoke-republish` (canonical recipe) or
// `run: bash scripts/smoke-republish.sh` (direct invocation).
// Checking for `run:` prefix prevents a comment mentioning the script from
// satisfying the predicate.
// ---------------------------------------------------------------------------
export function jobReferencesScript(yaml) {
  return (
    yaml.indexOf('run: just smoke-republish') !== -1 ||
    yaml.indexOf('run: bash scripts/smoke-republish.sh') !== -1
  );
}

// ---------------------------------------------------------------------------
// Pure predicate: the justfile text declares a `smoke-republish` recipe.
// ---------------------------------------------------------------------------
export function justfileHasSmokeRecipe(justfile) {
  return (
    justfile.indexOf('\nsmoke-republish:') !== -1 ||
    justfile.indexOf('\nsmoke-republish ') !== -1 ||
    justfile.startsWith('smoke-republish:') ||
    justfile.startsWith('smoke-republish ')
  );
}

// ---------------------------------------------------------------------------
// Pure predicate: the ADR content documents the failure policy.
// Accepts text that mentions "failure" AND either "next slice", "queue", or
// "priority" (per Drew's decision: failures are inserted as the NEXT slice).
// ---------------------------------------------------------------------------
export function adrHasFailurePolicy(content) {
  const lower = content.toLowerCase();
  return (
    lower.indexOf('failure') !== -1 &&
    (lower.indexOf('next slice') !== -1 ||
      lower.indexOf('queue') !== -1 ||
      lower.indexOf('priority') !== -1)
  );
}

// ---------------------------------------------------------------------------
// Pure predicate: the CI YAML does NOT wire smoke-republish (must be
// nightly-only; a PR gate on the live-server smoke test would block every PR).
// ---------------------------------------------------------------------------
export function ciDoesNotWireSmokeRepublish(yaml) {
  return yaml.indexOf('smoke-republish') === -1;
}

// ---------------------------------------------------------------------------
// m13.5a NEW PREDICATES (EARS 13.5a-2 + 13.5a-6)
// ---------------------------------------------------------------------------

// Truthy continue-on-error forms (mirror e2e-desync-teeth).
function isTruthyCoeNightly(value) {
  return /^(true|yes|on|True)\b/.test(value) || /\$\{\{\s*true\s*\}\}/.test(value);
}

// Helper: check that the job block extracted from yaml for jobName contains
// EXACTLY `- run: just <verb>` as a trimmed non-comment line.
// F6: raw indexOf('run: just X') accepts '- run: just X && true' or '- run: just X; exit 0'.
// Fix: require an EXACT trimmed match (same discipline as ciStepsUnneutered).
function jobBlockHasExactStep(yaml, jobName, verb) {
  const block = extractJobBlock(yaml, jobName);
  if (!block || block.trim() === '') return false;
  const exactStep = `- run: just ${verb}`;
  return block.split('\n').some((ln) => {
    const tr = ln.trim();
    return tr === exactStep && !tr.startsWith('#');
  });
}

// Pure predicate: nightly.yml has a `mutation:` job that runs EXACTLY `just mutate-core`.
export function nightlyHasMutationJob(yaml) {
  return jobBlockHasExactStep(yaml, 'mutation', 'mutate-core');
}

// Pure predicate: nightly.yml has a `coverage:` job that runs EXACTLY `just coverage`.
export function nightlyHasCoverageJob(yaml) {
  return jobBlockHasExactStep(yaml, 'coverage', 'coverage');
}

// Pure predicate: nightly.yml has a `mutation-server:` job that runs
// EXACTLY `just mutate-server`. Job name is a stable contract per ADR-0050 amendment.
export function nightlyHasServerMutationJob(yaml) {
  return jobBlockHasExactStep(yaml, 'mutation-server', 'mutate-server');
}

// Pure predicate: the named nightly job is not neutered.
// Returns { ok: boolean, reason: string }.
// Empty block → not-ok. Checks both job-level and step-level if:/continue-on-error:.
// Applied to mutation, coverage, mutation-server (NOT smoke-republish — its
// `if: failure()` log-dump step is legitimate; we do not call this on smoke-republish).
//
// FLAT-SCAN CONSTRAINT (deliberate, per ADR-0050): this is a flat line scan over
// the entire job block — it flags ANY `if:` key at any indent, including step-level.
// Consequence: mutation/coverage/mutation-server jobs must carry NO `if:` steps
// whatsoever (e.g. no `if: failure()` log-dump steps). If a guarded job ever needs
// a log-dump step, the step must use a different mechanism (e.g. always-run wrapper
// script) or this predicate must be extended with a step-scoped carve-out.
export function jobIsNotNeutered(yaml, jobName) {
  const block = extractJobBlock(yaml, jobName);
  if (!block || block.trim() === '') {
    return { ok: false, reason: `${jobName} job block is empty or absent` };
  }
  for (const line of block.split('\n')) {
    const tr = line.trim();
    if (tr.startsWith('#')) continue;
    if (tr.startsWith('if:')) {
      return {
        ok: false,
        reason: `${jobName} job/step has an if: condition — can disable or skip the job`,
      };
    }
    if (tr.startsWith('continue-on-error:')) {
      const value = tr.slice('continue-on-error:'.length).trim();
      if (isTruthyCoeNightly(value)) {
        return {
          ok: false,
          reason: `${jobName} job/step has a truthy continue-on-error: ${value}`,
        };
      }
    }
  }
  return { ok: true, reason: `${jobName} job is present and not neutered` };
}

// Pure predicate: nightly triggers on schedule (with a cron: line) AND
// workflow_dispatch. Comment-aware: commented-out triggers must not satisfy.
export function nightlyTriggersOnScheduleAndDispatch(yaml) {
  const lines = yaml.split('\n');
  let inOn = false;
  let hasSchedule = false;
  let hasCron = false;
  let hasDispatch = false;

  for (const line of lines) {
    const isComment = line.trim().startsWith('#');
    const isTopLevelKey = /^\S.*:/.test(line);

    if (/^on:/.test(line)) {
      inOn = true;
      continue;
    }
    if (inOn) {
      if (isTopLevelKey && !/^on\b/.test(line)) {
        inOn = false;
        continue;
      }
      if (!isComment) {
        if (line.trim() === 'schedule:' || line.trim().startsWith('schedule:')) hasSchedule = true;
        if (line.trim().startsWith('- cron:') || line.trim().startsWith('cron:')) hasCron = true;
        if (line.trim() === 'workflow_dispatch:' || line.trim() === 'workflow_dispatch') {
          hasDispatch = true;
        }
      }
    }
  }
  return hasSchedule && hasCron && hasDispatch;
}

// Pure predicate: the justfile `coverage:` recipe body contains
// `--coverage.thresholds.lines=` with a value ≥ 96.
// Rejects: flag absent, value = 0, value = 25.
//
// F4: parse the LAST occurrence, not the first — vitest uses the last duplicate
// flag value. `...lines=96 ...lines=0` would pass a first-occurrence check while
// the tool actually uses 0.
//
// F5: strip inline shell comment tails (` # …` — a `#` preceded by whitespace)
// from each body line before scanning. A flag appearing ONLY after a ` #` tail is
// not active code and must not satisfy the gate.
// Note: we only strip from the first occurrence of ` #` preceded by a space so
// we never mangle legitimate flag values that contain `#` (none in practice).
export function coverageRecipeThresholdIntact(justfileText) {
  // Find the coverage: recipe body using a simple line scan.
  const lines = justfileText.split('\n');
  let inRecipe = false;
  const bodyLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('coverage:') || line.startsWith('coverage ')) {
      inRecipe = true;
      continue;
    }
    if (inRecipe) {
      if (line.length === 0) continue;
      if (line[0] === ' ' || line[0] === '\t') {
        bodyLines.push(line.trimStart());
      } else {
        break;
      }
    }
  }
  if (!bodyLines.length) return false;

  const FLAG = '--coverage.thresholds.lines=';

  // F5: strip inline ` # …` comment tails from each body line.
  // We split on ` #` (space+hash) and keep the part before the first match.
  // This correctly handles:
  //   `npx vitest run --coverage --coverage.thresholds.lines=96`  → unchanged
  //   `npx vitest run --coverage # --coverage.thresholds.lines=96` → `npx vitest run --coverage`
  const strippedBody = bodyLines
    .map((ln) => {
      const commentIdx = ln.indexOf(' #');
      return commentIdx !== -1 ? ln.slice(0, commentIdx) : ln;
    })
    .join('\n');

  // F4: collect ALL occurrences; use the LAST one (mirrors vitest last-flag-wins).
  let lastThreshold = -1;
  let searchFrom = 0;
  while (true) {
    const idx = strippedBody.indexOf(FLAG, searchFrom);
    if (idx === -1) break;
    const afterFlag = strippedBody.slice(idx + FLAG.length);
    let numStr = '';
    for (const ch of afterFlag) {
      if (ch >= '0' && ch <= '9') numStr += ch;
      else break;
    }
    if (numStr) lastThreshold = parseInt(numStr, 10);
    searchFrom = idx + FLAG.length;
  }

  if (lastThreshold === -1) return false; // flag absent or no parseable value
  return lastThreshold >= 96;
}

// Pure predicate: the justfile has a `mutate-server` recipe whose body:
//   - contains `monster-realm-module`
//   - contains `missed.txt` (the count-compare gate — dropping it reverts to exit-2-tolerated theater)
//   - contains `--test-tool nextest` (measurement methodology per ADR-0050 baseline;
//     removing it silently changes which test runner cargo-mutants uses)
//   - does NOT contain `--shard` (scope-narrowing bypass)
//   - does NOT contain `--file` (scope-narrowing bypass)
//   - does NOT contain `--exclude-re` (scope-narrowing bypass)
//   - does NOT contain ` -o ` (space-delimited, F10: redirecting output to a different
//     path leaves the recipe reading a stale or wrong missed.txt)
//   - does NOT contain `--output` (F10 long form)
//   - the `cap=` default in the recipe signature parses as an integer ≤ 340
//     (catches cap="9999"; deliberate in-ceiling bumps allowed per ADR-0050 A2 as re-baselined by ADR-0118)
//   - if `cap=` is present but no digit follows the `=` (after optional quote),
//     the header is malformed → return false (tightened per reviewer n4)
export function mutateServerRecipeIntact(justfileText) {
  // Find the recipe header: `mutate-server` at column 0.
  const lines = justfileText.split('\n');
  let headerLine = '';
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('mutate-server:') || lines[i].startsWith('mutate-server ')) {
      headerLine = lines[i];
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return false;

  // Parse `cap=` default from the header (e.g. `mutate-server cap="150":` or
  // `mutate-server cap='150':` or `mutate-server cap=150:`).
  // We require a cap= parameter whose value is an integer ≤ 340.
  // If cap= is present but has no digits (malformed), return false.
  const capMatch = headerLine.indexOf('cap=');
  if (capMatch !== -1) {
    const afterCap = headerLine.slice(capMatch + 4);
    // Strip optional quotes.
    let capStr = afterCap;
    if (capStr.startsWith('"') || capStr.startsWith("'")) capStr = capStr.slice(1);
    // Read digits.
    let numStr = '';
    for (const ch of capStr) {
      if (ch >= '0' && ch <= '9') numStr += ch;
      else break;
    }
    // Malformed: cap= present but no digits follow (e.g. `cap=:` or `cap="`).
    if (!numStr) return false;
    const cap = parseInt(numStr, 10);
    if (cap > 340) return false;
  }
  // cap= is optional in the recipe; absence is fine (no cap or handled differently).

  // Collect body lines.
  const bodyLines = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) continue;
    if (line[0] === ' ' || line[0] === '\t') {
      const tr = line.trimStart();
      if (!tr.startsWith('#')) bodyLines.push(tr);
    } else {
      break;
    }
  }
  const body = bodyLines.join('\n');
  if (!body) return false;

  if (body.indexOf('monster-realm-module') === -1) return false;
  if (body.indexOf('missed.txt') === -1) return false;
  if (body.indexOf('--test-tool nextest') === -1) return false;
  if (body.indexOf('--shard') !== -1) return false;
  if (body.indexOf('--file') !== -1) return false;
  if (body.indexOf('--exclude-re') !== -1) return false;
  // F10: ban -o (space-delimited so we don't false-hit inside words like --coverage)
  // and --output. Both redirect cargo-mutants output, leaving the recipe reading a
  // stale default-path missed.txt rather than the actual output.
  if (body.indexOf(' -o ') !== -1) return false;
  if (body.indexOf('--output') !== -1) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Default export: proof-of-teeth, then real file checks.
// ---------------------------------------------------------------------------
export default async function () {
  const name =
    'nightly-smoke-wiring (ADR-0079 / 12.5b-6: republish-without-delete smoke test wired to nightly, not per-PR)';

  // =========================================================================
  // PROOF-OF-TEETH — known-bad fixtures first, then known-good positive controls
  // =========================================================================

  // TEETH A — nightly.yml without smoke-republish job must be rejected.
  const nightlyNoSmoke = `name: Nightly
on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;
  if (nightlyHasSmokeRepublishJob(nightlyNoSmoke)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH A: nightlyHasSmokeRepublishJob accepted a nightly.yml with no smoke-republish job (false positive)',
    };
  }

  // TEETH A-good — nightly.yml with the job must be accepted.
  const nightlyWithSmoke = `name: Nightly
on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  smoke-republish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash scripts/smoke-republish.sh
`;
  if (!nightlyHasSmokeRepublishJob(nightlyWithSmoke)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH A-good: nightlyHasSmokeRepublishJob rejected a nightly.yml that correctly contains smoke-republish (false negative)',
    };
  }

  // TEETH B — job block without script reference must be rejected.
  const yamlNoScript = `jobs:
  smoke-republish:
    runs-on: ubuntu-latest
    steps:
      - run: echo "no script here"
`;
  if (jobReferencesScript(yamlNoScript)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH B: jobReferencesScript accepted a job block with no smoke-republish.sh reference (false positive)',
    };
  }

  // TEETH B-good — job block with script reference must be accepted.
  const yamlWithScript = `jobs:
  smoke-republish:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/smoke-republish.sh http://127.0.0.1:3000 monster-realm-smoke
`;
  if (!jobReferencesScript(yamlWithScript)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH B-good: jobReferencesScript rejected a job block that correctly references smoke-republish.sh (false negative)',
    };
  }

  // TEETH C — justfile without smoke-republish recipe must be rejected.
  const justfileNoRecipe = `ci: lint typecheck test\n\nlint:\n    cargo fmt --all --check\n`;
  if (justfileHasSmokeRecipe(justfileNoRecipe)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH C: justfileHasSmokeRecipe accepted a justfile with no smoke-republish recipe (false positive)',
    };
  }

  // TEETH C-good — justfile with recipe must be accepted.
  const justfileWithRecipe = `ci: lint typecheck test\n\nsmoke-republish:\n    bash scripts/smoke-republish.sh\n`;
  if (!justfileHasSmokeRecipe(justfileWithRecipe)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH C-good: justfileHasSmokeRecipe rejected a justfile that correctly declares smoke-republish recipe (false negative)',
    };
  }

  // TEETH D — ADR without failure policy must be rejected.
  const adrNoPolicy = `# ADR-0079\n\nThis ADR documents the nightly smoke test.\n\n## Context\n\nWe run a smoke test nightly.\n`;
  if (adrHasFailurePolicy(adrNoPolicy)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH D: adrHasFailurePolicy accepted an ADR without a failure policy section (false positive)',
    };
  }

  // TEETH D-good — ADR with failure policy must be accepted.
  const adrWithPolicy = `# ADR-0079\n\n## Failure policy\n\nAny nightly failure is inserted into the milestone slice queue as the next slice to work on when detected (same priority as fix-red-master).\n`;
  if (!adrHasFailurePolicy(adrWithPolicy)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH D-good: adrHasFailurePolicy rejected an ADR that correctly documents the failure policy (false negative)',
    };
  }

  // TEETH E — ci.yml that contains smoke-republish must be rejected (nightly-only invariant).
  const ciWithSmoke = `name: CI\njobs:\n  smoke-republish:\n    runs-on: ubuntu-latest\n`;
  if (ciDoesNotWireSmokeRepublish(ciWithSmoke)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH E: ciDoesNotWireSmokeRepublish accepted a ci.yml that wires smoke-republish (should be nightly-only, not per-PR)',
    };
  }

  // TEETH E-good — ci.yml without smoke-republish must be accepted.
  const ciNoSmoke = `name: CI\njobs:\n  ci:\n    runs-on: ubuntu-latest\n`;
  if (!ciDoesNotWireSmokeRepublish(ciNoSmoke)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH E-good: ciDoesNotWireSmokeRepublish rejected a ci.yml that correctly omits smoke-republish (false negative)',
    };
  }

  // =========================================================================
  // m13.5a PROOF-OF-TEETH (new predicates)
  // =========================================================================

  // Helper nightly fixture with all three required nightly jobs (mutation, coverage,
  // mutation-server), schedule+dispatch triggers, and NO neutering.
  const nightlyFull = `name: Nightly
on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v4
      - run: just mutate-core
  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v4
      - run: just coverage
  mutation-server:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v4
      - run: just mutate-server
  smoke-republish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v4
      - name: Dump logs on failure
        if: failure()
        run: cat /tmp/stdb-smoke.log || true
      - run: just smoke-republish
`;

  // --- TEETH F: nightlyHasMutationJob ---
  // Bad: mutation job absent.
  const nightlyNoMutation = `name: Nightly
on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:
jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  if (nightlyHasMutationJob(nightlyNoMutation)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH F: nightlyHasMutationJob accepted a nightly.yml with no mutation job (false positive)',
    };
  }
  // Good: mutation job present with just mutate-core.
  if (!nightlyHasMutationJob(nightlyFull)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH F-good: nightlyHasMutationJob rejected a nightly.yml that correctly contains mutation job (false negative)',
    };
  }

  // --- TEETH G: nightlyHasCoverageJob ---
  // Bad: coverage job absent.
  const nightlyNoCoverage = `name: Nightly
on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
`;
  if (nightlyHasCoverageJob(nightlyNoCoverage)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH G: nightlyHasCoverageJob accepted a nightly.yml with no coverage job (false positive)',
    };
  }
  // Good: coverage job present.
  if (!nightlyHasCoverageJob(nightlyFull)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH G-good: nightlyHasCoverageJob rejected a nightly.yml that correctly contains coverage job (false negative)',
    };
  }

  // --- TEETH H: nightlyHasServerMutationJob ---
  // Bad: mutation-server job absent (the current real-tree state).
  // Kills: impl that returns true for a missing job.
  const nightlyNoMutationServer = `name: Nightly
on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  if (nightlyHasServerMutationJob(nightlyNoMutationServer)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH H: nightlyHasServerMutationJob accepted a nightly.yml with no mutation-server job (false positive) — kills impl that does not check job presence',
    };
  }
  // Good: mutation-server job present.
  if (!nightlyHasServerMutationJob(nightlyFull)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH H-good: nightlyHasServerMutationJob rejected a nightly.yml that correctly contains mutation-server job (false negative)',
    };
  }

  // --- TEETH I: jobIsNotNeutered ---
  // Bad: mutation-server with continue-on-error: true → neutered.
  // Kills: impl that ignores continue-on-error on nightly jobs.
  const nightlyMutServerCoe = `name: Nightly
on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:
jobs:
  mutation-server:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - run: just mutate-server
`;
  {
    const r = jobIsNotNeutered(nightlyMutServerCoe, 'mutation-server');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH I-coe: jobIsNotNeutered should reject mutation-server with job-level continue-on-error: true',
      };
    }
  }
  // Bad: mutation-server with if: condition → neutered.
  const nightlyMutServerIf = `name: Nightly
on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:
jobs:
  mutation-server:
    runs-on: ubuntu-latest
    if: false
    steps:
      - run: just mutate-server
`;
  {
    const r = jobIsNotNeutered(nightlyMutServerIf, 'mutation-server');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH I-if: jobIsNotNeutered should reject mutation-server with job-level if: false',
      };
    }
  }
  // Bad: job absent → not-ok.
  {
    const r = jobIsNotNeutered(nightlyNoMutationServer, 'mutation-server');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: 'TEETH I-absent: jobIsNotNeutered should return not-ok for absent job',
      };
    }
  }
  // Good: mutation-server job present and unneutered.
  {
    const r = jobIsNotNeutered(nightlyFull, 'mutation-server');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH I-good: jobIsNotNeutered should accept unneutered mutation-server job but rejected: ${r.reason}`,
      };
    }
  }
  // Positive control: smoke-republish has a legitimate `if: failure()` log-dump step.
  // jobIsNotNeutered called on smoke-republish must detect the if: and return not-ok
  // — this is correct behavior (we deliberately do NOT call jobIsNotNeutered on
  // smoke-republish in the real checks; this fixture documents why).
  {
    const r = jobIsNotNeutered(nightlyFull, 'smoke-republish');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH I-smoke-positive-control: jobIsNotNeutered should return not-ok for smoke-republish (it has a legitimate if: failure() step) — this confirms we must NOT call jobIsNotNeutered on smoke-republish in the real checks',
      };
    }
  }

  // --- TEETH J: nightlyTriggersOnScheduleAndDispatch ---
  // Bad: schedule commented out.
  // Kills: impl that searches raw text for `schedule:` without respecting comments.
  const nightlyCommentedSchedule = `name: Nightly
on:
  # schedule:
  #   - cron: '0 7 * * *'
  workflow_dispatch:
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
`;
  if (nightlyTriggersOnScheduleAndDispatch(nightlyCommentedSchedule)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH J-commented-schedule: nightlyTriggersOnScheduleAndDispatch accepted a nightly.yml where schedule: is only in a comment — kills impl that searches raw text',
    };
  }
  // Bad: workflow_dispatch absent.
  const nightlyNoDispatch = `name: Nightly
on:
  schedule:
    - cron: '0 7 * * *'
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
`;
  if (nightlyTriggersOnScheduleAndDispatch(nightlyNoDispatch)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH J-no-dispatch: nightlyTriggersOnScheduleAndDispatch accepted a nightly.yml missing workflow_dispatch',
    };
  }
  // Good: both present.
  if (!nightlyTriggersOnScheduleAndDispatch(nightlyFull)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH J-good: nightlyTriggersOnScheduleAndDispatch rejected a nightly.yml that correctly has schedule + workflow_dispatch (false negative)',
    };
  }

  // --- TEETH K: coverageRecipeThresholdIntact ---
  // Bad: threshold = 25 (current real-tree placeholder).
  // Kills: impl that accepts any integer.
  const justfileCoverage25 = `coverage:\n    cd client && npm ci && npx vitest run --coverage --coverage.thresholds.lines=25\n`;
  if (coverageRecipeThresholdIntact(justfileCoverage25)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH K-25: coverageRecipeThresholdIntact accepted threshold=25 (should require ≥96) — kills impl that accepts any integer',
    };
  }
  // Bad: flag absent entirely.
  const justfileCoverageNoFlag = `coverage:\n    cd client && npm ci && npx vitest run --coverage\n`;
  if (coverageRecipeThresholdIntact(justfileCoverageNoFlag)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH K-noflag: coverageRecipeThresholdIntact accepted a coverage recipe with no --coverage.thresholds.lines= flag',
    };
  }
  // Bad: threshold = 0.
  const justfileCoverage0 = `coverage:\n    cd client && npm ci && npx vitest run --coverage --coverage.thresholds.lines=0\n`;
  if (coverageRecipeThresholdIntact(justfileCoverage0)) {
    return {
      name,
      pass: false,
      detail: 'TEETH K-0: coverageRecipeThresholdIntact accepted threshold=0',
    };
  }
  // Good: threshold = 96.
  const justfileCoverage96 = `coverage:\n    cd client && npm ci && npx vitest run --coverage --coverage.thresholds.lines=96\n`;
  if (!coverageRecipeThresholdIntact(justfileCoverage96)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH K-96: coverageRecipeThresholdIntact rejected threshold=96 (should pass at exactly 96)',
    };
  }
  // Good: threshold = 99 (above floor).
  const justfileCoverage99 = `coverage:\n    cd client && npm ci && npx vitest run --coverage --coverage.thresholds.lines=99\n`;
  if (!coverageRecipeThresholdIntact(justfileCoverage99)) {
    return {
      name,
      pass: false,
      detail: 'TEETH K-99: coverageRecipeThresholdIntact rejected threshold=99',
    };
  }

  // --- TEETH L: mutateServerRecipeIntact ---
  // Bad: recipe absent.
  const justfileNoMutateServer = `ci: lint typecheck test\n\ntest:\n    cargo nextest run --workspace\n`;
  if (mutateServerRecipeIntact(justfileNoMutateServer)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH L-absent: mutateServerRecipeIntact accepted a justfile with no mutate-server recipe',
    };
  }
  // Bad: missed.txt absent.
  // Kills: impl that only checks module name.
  const justfileMutServerNoMissed = `mutate-server cap="150":\n    cargo mutants -p monster-realm-module --cap {{cap}}\n`;
  if (mutateServerRecipeIntact(justfileMutServerNoMissed)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH L-no-missed: mutateServerRecipeIntact accepted a mutate-server recipe without missed.txt — the count-compare gate must be present (dropping it reverts to exit-2-tolerated theater)',
    };
  }
  // Bad: --shard scope-narrowing bypass.
  const justfileMutServerShard = `mutate-server cap="150":\n    cargo mutants -p monster-realm-module --cap {{cap}} --shard 1/64 > missed.txt\n`;
  if (mutateServerRecipeIntact(justfileMutServerShard)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH L-shard: mutateServerRecipeIntact accepted a mutate-server recipe with --shard (scope-narrowing bypass)',
    };
  }
  // Bad: cap=9999 (exceeds ceiling).
  const justfileMutServerBigCap = `mutate-server cap="9999":\n    cargo mutants -p monster-realm-module --cap {{cap}} > missed.txt\n`;
  if (mutateServerRecipeIntact(justfileMutServerBigCap)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH L-bigcap: mutateServerRecipeIntact accepted cap=9999 (must reject cap > 340 per ADR-0050 A3 / ADR-0118)',
    };
  }
  // Bad: --file scope-narrowing bypass.
  const justfileMutServerFile = `mutate-server cap="150":\n    cargo mutants -p monster-realm-module --test-tool nextest --cap {{cap}} --file shop.rs > missed.txt\n`;
  if (mutateServerRecipeIntact(justfileMutServerFile)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH L-file: mutateServerRecipeIntact accepted a mutate-server recipe with --file (scope-narrowing bypass)',
    };
  }
  // Bad: --test-tool nextest absent (M3 — removing it silently changes measurement methodology).
  // Kills: impl that doesn't require the flag.
  const justfileMutServerNoNextest = `mutate-server cap="150":\n    cargo mutants -p monster-realm-module --cap {{cap}} 2>&1 | tee missed.txt\n`;
  if (mutateServerRecipeIntact(justfileMutServerNoNextest)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH L-no-nextest: mutateServerRecipeIntact accepted a mutate-server recipe without --test-tool nextest — removing it silently changes cargo-mutants measurement methodology vs the ADR-0050 baseline',
    };
  }
  // Bad: cap= present but malformed (no digits after =) — reviewer n4 tightening.
  // Kills: impl that silently allows malformed cap= headers.
  const justfileMutServerMalformedCap = `mutate-server cap=:\n    cargo mutants -p monster-realm-module --test-tool nextest 2>&1 | tee missed.txt\n`;
  if (mutateServerRecipeIntact(justfileMutServerMalformedCap)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH L-malformed-cap: mutateServerRecipeIntact accepted a mutate-server recipe with malformed cap= (no digits) — must return false when cap= has no parseable integer',
    };
  }
  // Good: all invariants satisfied (monster-realm-module, missed.txt, --test-tool nextest,
  // cap ≤ 340, no scope-narrowing flags).
  const justfileMutServerGood = `mutate-server cap="150":\n    cargo mutants -p monster-realm-module --test-tool nextest --cap {{cap}} 2>&1 | tee missed.txt\n`;
  if (!mutateServerRecipeIntact(justfileMutServerGood)) {
    return {
      name,
      pass: false,
      detail: 'TEETH L-good: mutateServerRecipeIntact rejected a correct mutate-server recipe',
    };
  }
  // Bad: cap=309 — exceeds tightened ceiling 299 (ADR-0137 amends ADR-0118 A3).
  // Kills: impl that still uses the old ceiling of 340, silently accepting a 41-mutant
  // loosening of the nightly survivor tolerance without any eval-visible signal.
  // NOTE: this was previously asserted ACCEPTED (ceiling was 340). It is now REJECTED
  // because ADR-0137 tightens the ceiling to the committed justfile cap=299 so every
  // cap move is eval-visible. Correction rationale: spec §ptc5d-4 / ADR-0137 D4.
  const justfileMutServerRecap = `mutate-server cap="309":\n    cargo mutants -p monster-realm-module --test-tool nextest --cap {{cap}} 2>&1 | tee missed.txt\n`;
  if (mutateServerRecipeIntact(justfileMutServerRecap)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH L-recap: mutateServerRecipeIntact accepted cap=309 — exceeds tightened ceiling 299 ' +
        '(ADR-0137 amends ADR-0118 A3; ceiling tightened from 340 to the committed justfile cap so ' +
        'every cap move is eval-visible; kills impl still using the old 340 ceiling)',
    };
  }

  // Bad: cap=300 — one above the ceiling (+ 1 boundary bite).
  // Kills: impl using >= instead of > at the 299 boundary (off-by-one).
  const justfileMutServerOvercap = `mutate-server cap="300":\n    cargo mutants -p monster-realm-module --test-tool nextest --cap {{cap}} 2>&1 | tee missed.txt\n`;
  if (mutateServerRecipeIntact(justfileMutServerOvercap)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH L-overcap: mutateServerRecipeIntact accepted cap=300 — must be rejected by the ' +
        'tightened ceiling 299 (ADR-0137 D4); this is the +1 boundary bite; ' +
        'kills impl using cap >= MUTATE_SERVER_CAP_BASELINE instead of cap > MUTATE_SERVER_CAP_BASELINE',
    };
  }

  // Good: cap=299 — exactly at the ceiling (must be ACCEPTED, not rejected).
  // Guards the > vs >= off-by-one: if the impl uses >= 299 it rejects 299 and this fires.
  const justfileMutServer299 = `mutate-server cap="299":\n    cargo mutants -p monster-realm-module --test-tool nextest --cap {{cap}} 2>&1 | tee missed.txt\n`;
  if (!mutateServerRecipeIntact(justfileMutServer299)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH L-299: mutateServerRecipeIntact rejected cap=299 — the committed justfile default ' +
        'is cap=299 and must be accepted (ceiling check is cap > 299, not cap >= 299); ' +
        'kills impl using >= MUTATE_SERVER_CAP_BASELINE (off-by-one)',
    };
  }

  // --- TEETH F4: coverageRecipeThresholdIntact last-occurrence semantics ---
  // Bad: 96 then 0 — vitest uses the LAST occurrence (=0), gate must reject.
  // Kills: impl that parses only the first occurrence.
  const justfileCoverage96then0 = `coverage:\n    cd client && npm ci && npx vitest run --coverage --coverage.thresholds.lines=96 --coverage.thresholds.lines=0\n`;
  if (coverageRecipeThresholdIntact(justfileCoverage96then0)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH F4: coverageRecipeThresholdIntact accepted --coverage.thresholds.lines=96 followed by =0 — vitest uses the LAST flag occurrence; impl must parse the last, not the first',
    };
  }
  // Good: 0 then 96 → last is 96, must pass.
  const justfileCoverage0then96 = `coverage:\n    cd client && npm ci && npx vitest run --coverage --coverage.thresholds.lines=0 --coverage.thresholds.lines=96\n`;
  if (!coverageRecipeThresholdIntact(justfileCoverage0then96)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH F4-good: coverageRecipeThresholdIntact rejected --coverage.thresholds.lines=0 then =96 (last is 96, should pass)',
    };
  }

  // --- TEETH F5: coverageRecipeThresholdIntact inline-comment stripping ---
  // Bad: flag appears only after ` # ` inline comment tail — not active code.
  // Kills: impl that searches the raw body without stripping inline comment tails.
  const justfileCoverageInlineComment = `coverage:\n    cd client && npm ci && npx vitest run --coverage # --coverage.thresholds.lines=96\n`;
  if (coverageRecipeThresholdIntact(justfileCoverageInlineComment)) {
    return {
      name,
      pass: false,
      detail:
        "TEETH F5: coverageRecipeThresholdIntact accepted a recipe where the threshold flag appears only after an inline ' # ' comment tail — must strip ` # ...` tails before searching",
    };
  }
  // Good: flag before the comment tail → active, must pass.
  const justfileCoverageBeforeComment = `coverage:\n    cd client && npm ci && npx vitest run --coverage --coverage.thresholds.lines=96 # enforced\n`;
  if (!coverageRecipeThresholdIntact(justfileCoverageBeforeComment)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH F5-good: coverageRecipeThresholdIntact rejected a recipe where the threshold flag appears BEFORE an inline comment tail (flag is active code)',
    };
  }

  // --- TEETH F6: nightlyHas*Job exact-step discipline ---
  // Bad: `- run: just mutate-core && true` suffix — indexOf would accept, exact must not.
  // Kills: impl that uses raw indexOf('run: just X') without exact-step check.
  const nightlyMutationSuffix = `name: Nightly
on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core && true
`;
  if (nightlyHasMutationJob(nightlyMutationSuffix)) {
    return {
      name,
      pass: false,
      detail:
        "TEETH F6-mutation: nightlyHasMutationJob accepted '- run: just mutate-core && true' — must require EXACT trimmed step (same discipline as ciStepsUnneutered)",
    };
  }
  // Bad: `- run: just coverage; exit 0` suffix for coverage job.
  const nightlyCoverageSuffix = `name: Nightly
on:
  workflow_dispatch:
jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage; exit 0
`;
  if (nightlyHasCoverageJob(nightlyCoverageSuffix)) {
    return {
      name,
      pass: false,
      detail:
        "TEETH F6-coverage: nightlyHasCoverageJob accepted '- run: just coverage; exit 0' — must require EXACT trimmed step",
    };
  }
  // Bad: `- run: just mutate-server || true` suffix for mutation-server job.
  const nightlyMutServerSuffix = `name: Nightly
on:
  workflow_dispatch:
jobs:
  mutation-server:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-server || true
`;
  if (nightlyHasServerMutationJob(nightlyMutServerSuffix)) {
    return {
      name,
      pass: false,
      detail:
        "TEETH F6-server: nightlyHasServerMutationJob accepted '- run: just mutate-server || true' — must require EXACT trimmed step",
    };
  }
  // Good: exact forms must still pass (reconfirm nightlyFull positive controls).
  if (!nightlyHasMutationJob(nightlyFull)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH F6-mutation-good: nightlyHasMutationJob rejected a correct exact-step fixture after F6 fix — good fixture must still pass',
    };
  }
  if (!nightlyHasCoverageJob(nightlyFull)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH F6-coverage-good: nightlyHasCoverageJob rejected a correct exact-step fixture after F6 fix',
    };
  }
  if (!nightlyHasServerMutationJob(nightlyFull)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH F6-server-good: nightlyHasServerMutationJob rejected a correct exact-step fixture after F6 fix',
    };
  }

  // --- TEETH F10: mutateServerRecipeIntact -o / --output ban ---
  // Bad: recipe uses `-o /tmp/x` (short-form redirect) — leaves recipe reading stale missed.txt.
  // Kills: impl that doesn't ban the -o flag.
  const justfileMutServerDashO = `mutate-server cap="150":\n    cargo mutants -p monster-realm-module --test-tool nextest --cap {{cap}} -o /tmp/mutations.txt && wc -l /tmp/mutations.txt > missed.txt\n`;
  if (mutateServerRecipeIntact(justfileMutServerDashO)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH F10-dash-o: mutateServerRecipeIntact accepted a mutate-server recipe with `-o /tmp/x` (output redirect) — must ban ` -o ` as a space-delimited token; redirecting output leaves the recipe reading a stale missed.txt',
    };
  }
  // Bad: recipe uses `--output`.
  const justfileMutServerOutput = `mutate-server cap="150":\n    cargo mutants -p monster-realm-module --test-tool nextest --cap {{cap}} --output /tmp/mutations 2>&1 | tee missed.txt\n`;
  if (mutateServerRecipeIntact(justfileMutServerOutput)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH F10-output: mutateServerRecipeIntact accepted a mutate-server recipe with --output — must ban this flag',
    };
  }
  // Good: the canonical recipe (no -o / --output) must still pass.
  if (!mutateServerRecipeIntact(justfileMutServerGood)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH F10-good: mutateServerRecipeIntact rejected the canonical good recipe after F10 ban was added',
    };
  }

  // =========================================================================
  // REAL FILE CHECKS
  // =========================================================================
  const root = path.resolve('.');

  const nightlyPath = path.join(root, '.github/workflows/nightly.yml');
  const ciPath = path.join(root, '.github/workflows/ci.yml');
  const justfilePath = path.join(root, 'justfile');
  const scriptPath = path.join(root, 'scripts/smoke-republish.sh');
  const adrPath = path.join(root, 'docs/adr/0079-nightly-republish-smoke.md');

  let nightlyYml, ciYml, justfile, adrContent;

  try {
    nightlyYml = readFileSync(nightlyPath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read .github/workflows/nightly.yml' };
  }
  try {
    ciYml = readFileSync(ciPath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read .github/workflows/ci.yml' };
  }
  try {
    justfile = readFileSync(justfilePath, 'utf8');
  } catch {
    return { name, pass: false, detail: 'cannot read justfile' };
  }

  // Script existence + non-trivial content check (existsSync alone passes for an empty file).
  if (!existsSync(scriptPath)) {
    return {
      name,
      pass: false,
      detail: 'scripts/smoke-republish.sh does not exist — the smoke script must be committed',
    };
  }
  const scriptContent = readFileSync(scriptPath, 'utf8');
  if (scriptContent.length < 100 || !scriptContent.startsWith('#!/usr/bin/env bash')) {
    return {
      name,
      pass: false,
      detail:
        'scripts/smoke-republish.sh is empty or missing #!/usr/bin/env bash shebang — the committed file is not a valid smoke script',
    };
  }
  if (!scriptContent.includes('set -euo pipefail')) {
    return {
      name,
      pass: false,
      detail:
        'scripts/smoke-republish.sh is missing set -euo pipefail — error-handling posture must be enforced',
    };
  }

  try {
    adrContent = readFileSync(adrPath, 'utf8');
  } catch {
    return {
      name,
      pass: false,
      detail:
        'docs/adr/0079-nightly-republish-smoke.md does not exist — failure policy must be documented',
    };
  }

  // Check 1: nightly.yml has smoke-republish job
  if (!nightlyHasSmokeRepublishJob(nightlyYml)) {
    return {
      name,
      pass: false,
      detail:
        'nightly.yml does not contain a smoke-republish job — the nightly smoke test is not wired',
    };
  }

  // Check 2: ci.yml does NOT have smoke-republish (nightly-only guard)
  if (!ciDoesNotWireSmokeRepublish(ciYml)) {
    return {
      name,
      pass: false,
      detail:
        'ci.yml contains smoke-republish — the smoke test must be nightly-only, not a per-PR gate (it requires a live SpacetimeDB instance)',
    };
  }

  // Check 3: nightly.yml smoke job references the script
  if (!jobReferencesScript(nightlyYml)) {
    return {
      name,
      pass: false,
      detail: 'nightly.yml smoke-republish job does not reference scripts/smoke-republish.sh',
    };
  }

  // Check 4: justfile has smoke-republish recipe
  if (!justfileHasSmokeRecipe(justfile)) {
    return {
      name,
      pass: false,
      detail: 'justfile does not contain a smoke-republish recipe',
    };
  }

  // Check 5: ADR-0079 documents the failure policy
  if (!adrHasFailurePolicy(adrContent)) {
    return {
      name,
      pass: false,
      detail:
        'docs/adr/0079-nightly-republish-smoke.md does not document the failure policy (must mention "failure" and "next slice"/"queue"/"priority")',
    };
  }

  // =========================================================================
  // m13.5a REAL FILE CHECKS (appended after existing checks)
  // EXPECTED RED state:
  //   Check 6 (nightlyHasMutationJob)     → GREEN (mutation job already present)
  //   Check 7 (nightlyHasCoverageJob)     → GREEN (coverage job already present)
  //   Check 8 (nightlyHasServerMutationJob) → FAIL (mutation-server job absent)
  //   Check 9 (jobIsNotNeutered mutation)   → GREEN
  //   Check 10 (jobIsNotNeutered coverage)  → GREEN
  //   Check 11 (nightlyTriggersOnScheduleAndDispatch) → GREEN
  //   Check 12 (coverageRecipeThresholdIntact) → FAIL (threshold still =25)
  //   Check 13 (mutateServerRecipeIntact)      → FAIL (recipe absent)
  // =========================================================================

  // Check 6: nightly.yml has mutation job
  if (!nightlyHasMutationJob(nightlyYml)) {
    return {
      name,
      pass: false,
      detail: 'nightly.yml does not contain a mutation job running just mutate-core',
    };
  }

  // Check 7: nightly.yml has coverage job
  if (!nightlyHasCoverageJob(nightlyYml)) {
    return {
      name,
      pass: false,
      detail: 'nightly.yml does not contain a coverage job running just coverage',
    };
  }

  // Check 8: nightly.yml has mutation-server job (EXPECTED RED — job absent)
  // GREEN edit: add `mutation-server:` job to nightly.yml with `run: just mutate-server`.
  if (!nightlyHasServerMutationJob(nightlyYml)) {
    return {
      name,
      pass: false,
      detail:
        'nightly.yml does not contain a mutation-server job running just mutate-server (EXPECTED RED — implementer must add the job per ADR-0050 amendment)',
    };
  }

  // Check 9: mutation job is not neutered
  {
    const r = jobIsNotNeutered(nightlyYml, 'mutation');
    if (!r.ok) {
      return { name, pass: false, detail: `mutation job is neutered in nightly.yml: ${r.reason}` };
    }
  }

  // Check 10: coverage job is not neutered
  {
    const r = jobIsNotNeutered(nightlyYml, 'coverage');
    if (!r.ok) {
      return { name, pass: false, detail: `coverage job is neutered in nightly.yml: ${r.reason}` };
    }
  }

  // Check 10.5: mutation-server job is not neutered (B1 — was missing; adding
  // continue-on-error to the new job would otherwise pass undetected).
  {
    const r = jobIsNotNeutered(nightlyYml, 'mutation-server');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `mutation-server job is neutered in nightly.yml: ${r.reason}`,
      };
    }
  }

  // Check 11: nightly triggers on schedule + workflow_dispatch
  if (!nightlyTriggersOnScheduleAndDispatch(nightlyYml)) {
    return {
      name,
      pass: false,
      detail:
        'nightly.yml does not trigger on both schedule (with cron:) and workflow_dispatch (or the triggers are commented out)',
    };
  }

  // Check 12: coverage recipe threshold ≥ 96 (EXPECTED RED — still =25)
  // GREEN edit: change --coverage.thresholds.lines=25 to ≥96 in the justfile coverage: recipe.
  if (!coverageRecipeThresholdIntact(justfile)) {
    return {
      name,
      pass: false,
      detail:
        'justfile coverage: recipe threshold is below 96 or the --coverage.thresholds.lines= flag is absent (EXPECTED RED — implementer must raise the threshold from =25 to ≥96)',
    };
  }

  // Check 13: mutate-server recipe is intact (EXPECTED RED — recipe absent)
  // GREEN edit: add a mutate-server recipe to the justfile with monster-realm-module,
  // missed.txt, cap ≤ 340, and no --shard/--file/--exclude-re narrowing.
  if (!mutateServerRecipeIntact(justfile)) {
    return {
      name,
      pass: false,
      detail:
        'justfile mutate-server recipe is absent or incomplete (EXPECTED RED — implementer must add the recipe: cargo mutants -p monster-realm-module --test-tool nextest with missed.txt count-compare, cap ≤ 340, no --shard/--file/--exclude-re)',
    };
  }

  return {
    name,
    pass: true,
    detail:
      'nightly smoke-republish correctly wired: job exists in nightly.yml (not ci.yml), references smoke-republish.sh, justfile recipe present, script committed, ADR-0079 documents the failure policy; m13.5a additions: mutation/coverage/mutation-server jobs present and unneutered, schedule+dispatch triggers live, coverage threshold ≥96, mutate-server recipe intact',
  };
}
