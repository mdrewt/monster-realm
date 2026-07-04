// Nightly republish smoke-test wiring eval (ADR-0079 / spec §12.5b-6).
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

// ---------------------------------------------------------------------------
// Pure predicate: nightly.yml has a `smoke-republish:` job at the 2-space
// job-key indent level inside a `jobs:` block.
// ---------------------------------------------------------------------------
export function nightlyHasSmokeRepublishJob(yaml) {
  // Match "  smoke-republish:" at the start of a line (2-space indent = job key).
  return /\n {2}smoke-republish:\s/.test(yaml) || yaml.indexOf('\n  smoke-republish:\n') !== -1;
}

// ---------------------------------------------------------------------------
// Pure predicate: the nightly YAML invokes the smoke test — either directly
// via the script name or via `just smoke-republish` (the canonical recipe).
// ---------------------------------------------------------------------------
export function jobReferencesScript(yaml) {
  return yaml.indexOf('smoke-republish.sh') !== -1 || yaml.indexOf('just smoke-republish') !== -1;
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

  // Script existence (binary check — content checked by humans + CI shell tests)
  if (!existsSync(scriptPath)) {
    return {
      name,
      pass: false,
      detail: 'scripts/smoke-republish.sh does not exist — the smoke script must be committed',
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

  return {
    name,
    pass: true,
    detail:
      'nightly smoke-republish correctly wired: job exists in nightly.yml (not ci.yml), references smoke-republish.sh, justfile recipe present, script committed, ADR-0079 documents the failure policy',
  };
}
