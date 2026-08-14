// Nightly republish smoke-test wiring eval (ADR-0079 / spec §12.5b-6).
// Extended in m13.5a (EARS 13.5a-2 + guard-side of 13.5a-6) to also verify:
//   - mutation job exists and is not neutered
//   - coverage job exists and is not neutered
//   - mutation-server job exists (ADR-0050 amendment) and is not neutered
//   - nightly triggers on schedule + workflow_dispatch (not just push)
//   - coverage recipe threshold ≥ 96 (not the placeholder =25)
//   - mutate-server recipe is intact (missed.txt, no scope narrowing,
//     cap ≤ MUTATE_SERVER_CAP_BASELINE)
//
// Extended in 14r-a (nightly failure-policy documentation + cap/ceiling coupling):
//   - each guarded nightly job (mutation, mutation-server, coverage) documents its
//     failure policy in the contiguous comment preamble directly above its job key,
//     mirroring the smoke-republish precedent at .github/workflows/nightly.yml:78-83
//     (decision-hook mdrewt/claude-harness#14 — notification channel — is still open,
//     so the reversible default is a documented policy, NOT a notification Action)
//   - the committed justfile `mutate-server cap=` default EQUALS the wiring-eval
//     ceiling MUTATE_SERVER_CAP_BASELINE (ADR-0137 D4: both move in the same commit;
//     the pre-existing `cap ≤ ceiling` check alone makes a ceiling-only raise invisible)
//
// EXPECTED REAL-TREE STATE AT RED (m13.5a additions only — long since GREEN):
//   nightlyHasServerMutationJob → FAIL (mutation-server job absent from nightly.yml)
//   mutateServerRecipeIntact    → FAIL (mutate-server recipe absent from justfile)
//   coverageRecipeThresholdIntact → FAIL (threshold still =25 in justfile)
// All pre-existing checks (smoke-republish wiring) remain GREEN.
//
// EXPECTED REAL-TREE STATE AT RED (14r-a additions):
//   Check 14 jobHasFailurePolicyComment(nightly, 'mutation')        → FAIL (no policy preamble)
//   Check 15 jobHasFailurePolicyComment(nightly, 'mutation-server') → FAIL (no policy preamble)
//   Check 16 jobHasFailurePolicyComment(nightly, 'coverage')        → FAIL (no policy preamble)
//   Check 17 justfileCapEqualsCeiling(justfile)                     → GREEN today (the
//            committed cap already equals the ceiling); it becomes load-bearing the
//            moment either number moves without the other.
//   Checks 1–13 stay GREEN. Because this eval returns on first failure, the runner
//   reports Check 14 at RED; Checks 15/16 surface as the implementer fixes upward.
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
//   - the `cap=` default in the recipe signature parses as an integer
//     ≤ MUTATE_SERVER_CAP_BASELINE (catches cap="9999"; ceiling == committed cap
//     so any inflation is eval-visible)
//   - if `cap=` is present but no digit follows the `=` (after optional quote),
//     the header is malformed → return false (tightened per reviewer n4)

// Wiring-eval cap ceiling == the committed justfile `mutate-server cap=` default
// (the m17.5a re-measurement recorded under ADR-0118 §4 set both to 299; 14r-a
// re-baselined both to 324 per ADR-0183; the `just eval` run asserts the real
// justfile's cap parses ≤ this constant AND, since 14r-a, EQUALS it — see
// justfileCapEqualsCeiling below).
// ADR-0137 D4 tightens this from 340 to the cap so EVERY cap move is eval-visible
// (amends ADR-0118 §3/A3: headroom no longer lives in the ceiling). A legitimate
// server-growth re-baseline bumps BOTH the justfile cap and this constant in the
// same PR — the coupling is intentional (mechanical-enforcement-first).
const MUTATE_SERVER_CAP_BASELINE = 324;

// Shared helper: parse the `cap=` default out of a `mutate-server …` recipe header
// line (`mutate-server cap="299":`, `cap='299'`, `cap=299` all parse).
// Returns { present, cap }:
//   present === false             → the header declares no cap= parameter at all
//   present === true, cap === null → cap= present but MALFORMED (no digits follow)
//   present === true, cap === <int> → the parsed default
// Lifted verbatim out of mutateServerRecipeIntact's inline parse (behaviour
// unchanged — TEETH L pins it) so that predicate and justfileCapEqualsCeiling can
// never disagree about what the committed cap IS: under ADR-0137 D4 they are two
// views of ONE number (`cap ≤ ceiling` and `cap === ceiling`).
function parseCapDefaultFromHeader(headerLine) {
  const capIdx = headerLine.indexOf('cap=');
  if (capIdx === -1) return { present: false, cap: null };
  // Strip optional quotes, then read leading digits.
  let capStr = headerLine.slice(capIdx + 4);
  if (capStr.startsWith('"') || capStr.startsWith("'")) capStr = capStr.slice(1);
  let numStr = '';
  for (const ch of capStr) {
    if (ch >= '0' && ch <= '9') numStr += ch;
    else break;
  }
  if (!numStr) return { present: true, cap: null };
  return { present: true, cap: parseInt(numStr, 10) };
}

// Shared helper: the `mutate-server` recipe header line (column 0), or null.
function findMutateServerHeaderLine(justfileText) {
  for (const line of justfileText.split('\n')) {
    if (line.startsWith('mutate-server:') || line.startsWith('mutate-server ')) return line;
  }
  return null;
}

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
  // `mutate-server cap='150':` or `mutate-server cap=150:`) via the shared helper.
  // We require a cap= parameter whose value is an integer ≤ MUTATE_SERVER_CAP_BASELINE.
  // If cap= is present but has no digits (malformed), return false.
  const capInfo = parseCapDefaultFromHeader(headerLine);
  if (capInfo.present) {
    // Malformed: cap= present but no digits follow (e.g. `cap=:` or `cap="`).
    if (capInfo.cap === null) return false;
    if (capInfo.cap > MUTATE_SERVER_CAP_BASELINE) return false;
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
// 14r-a NEW PREDICATES
// ---------------------------------------------------------------------------

// Routing vocabulary — deliberately the SAME set adrHasFailurePolicy accepts, so
// an in-workflow policy comment and the ADR prose speak one language.
const POLICY_ROUTING_KEYWORDS = ['next slice', 'queue', 'priority'];

// Clause-3 normalisation for one preamble comment line: drop the leading `#`,
// collapse every run of spaces/tabs to a single space, trim, lowercase.
// Literal regex only — NO new RegExp (detect-non-literal-regexp has bitten 3×).
function normalisePolicyCommentLine(line) {
  let text = line.trim();
  if (text.startsWith('#')) text = text.slice(1);
  return text
    .replace(/[ \t]+/g, ' ')
    .trim()
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Pure predicate: the nightly job `jobName` carries a DOCUMENTED failure policy
// in the contiguous comment preamble immediately ABOVE its job key — the
// `smoke-republish` precedent at .github/workflows/nightly.yml:78-83.
// Returns { ok: boolean, reason: string }.
//
// WHY A COMMENT AND NOT A NOTIFICATION ACTION: decision-hook
// mdrewt/claude-harness#14 (nightly failure notification channel) is OPEN. The
// reversible default is an in-workflow documented policy; no notification Action
// may be added until that hook resolves. A comment costs nothing to unwind.
//
// SEMANTICS — each clause kills a specific false-green (teeth M1–M8):
//   1. KEY SCAN ANCHORED UNDER `jobs:` — the key is only looked for at/after the
//      first line that is exactly `jobs:` (indent 0), and is matched EXACTLY the
//      way extractJobBlock matches it (a line equal to `  <job>:` or starting
//      with `  <job>: `). Without the anchor, a 2-space key with a colliding
//      name under `on:`/`env:` carrying a nice comment would satisfy the gate
//      while the REAL job stays unannotated (tooth M8).
//   2. CONTIGUOUS PREAMBLE WALK — from the key line UPWARD, collect lines while
//      indent is exactly 2 AND the trimmed line starts with `#`. The first
//      blank / non-comment / other-indent line stops the walk (teeth M4, M7).
//      `indent === 2` is deliberately STRICT: relaxing it to `>= 2` re-opens the
//      in-block-placement hole that tooth M5 exists to catch.
//   3. PER-LINE NORMALISATION — see normalisePolicyCommentLine. Lines stay an
//      ARRAY and are never joined into one blob; joining would let clause 4's
//      phrase and the job name come from two different comment lines.
//   4. ANCHORED, SINGLE-LINE, SELF-ATTRIBUTING PHRASE — at least ONE normalised
//      line must contain the contiguous substring "failure policy for `<job>`:".
//      Binding the phrase and the job name to the SAME line forecloses
//      cross-attribution: a preamble that documents ANOTHER job's failure policy
//      while merely mentioning this job's backticked name elsewhere must NOT
//      satisfy (tooth M3c). The backticks also stop `mutation` ⊂
//      `mutation-server` substring bleed (tooth M3b) without needing a regex.
//   5. ROUTING KEYWORD — the preamble (any of its lines) must contain one of
//      `next slice` / `queue` / `priority`.
//
// KNOWN LIMITATION (accepted, stated deliberately): a keyword gate cannot detect
// NEGATED prose — "Failure policy for `coverage`: failures are NOT queued"
// satisfies clauses 4 and 5. This gate proves the policy is DOCUMENTED and
// ATTRIBUTED to the right job; it does not prove it is semantically affirmative.
// Semantic review stays with the human reviewer and the ADR.
export function jobHasFailurePolicyComment(yaml, jobName) {
  const lines = yaml.split('\n');
  const keyAbsent = `${jobName}: job key absent at 2-space indent under jobs:`;

  // Clause 1: anchor the key scan at the top-level `jobs:` line.
  let jobsIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'jobs:') {
      jobsIdx = i;
      break;
    }
  }
  if (jobsIdx === -1) {
    return { ok: false, reason: `${keyAbsent} (no top-level jobs: line in this workflow)` };
  }
  const keyLine = `  ${jobName}:`;
  let keyIdx = -1;
  for (let i = jobsIdx; i < lines.length; i++) {
    if (lines[i] === keyLine || lines[i].startsWith(`${keyLine} `)) {
      keyIdx = i;
      break;
    }
  }
  if (keyIdx === -1) {
    return { ok: false, reason: keyAbsent };
  }

  // Clauses 2 + 3: walk upward, normalising as we go. Order does not matter —
  // we only ever test membership — so we keep the natural bottom-up order.
  const preamble = [];
  for (let i = keyIdx - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === '') break;
    const indent = line.length - line.trimStart().length;
    if (indent !== 2) break;
    if (!line.trim().startsWith('#')) break;
    preamble.push(normalisePolicyCommentLine(line));
  }

  // Clause 4: anchored, single-line, self-attributing phrase.
  const phrase = `failure policy for \`${jobName.toLowerCase()}\`:`;
  const hasPhrase = preamble.some((ln) => ln.indexOf(phrase) !== -1);
  if (!hasPhrase) {
    return {
      ok: false,
      reason:
        `${jobName}: the contiguous 2-space comment preamble directly above the job ` +
        `key has no line containing the anchored policy phrase "${phrase}" — the ` +
        'phrase must sit on a SINGLE comment line (do not line-wrap it between the ' +
        'backticked job name and the colon) and must name THIS job, so a policy ' +
        'written for a neighbouring job cannot be credited to this one',
    };
  }

  // Clause 5: routing keyword, anywhere in the preamble.
  let hasRouting = false;
  for (const ln of preamble) {
    for (const kw of POLICY_ROUTING_KEYWORDS) {
      if (ln.indexOf(kw) !== -1) hasRouting = true;
    }
  }
  if (!hasRouting) {
    return {
      ok: false,
      reason:
        `${jobName}: the failure-policy preamble never says where a failure is ` +
        'routed — it must contain one of "next slice" / "queue" / "priority" (the ' +
        'same vocabulary adrHasFailurePolicy accepts)',
    };
  }

  return {
    ok: true,
    reason: `${jobName}: failure policy documented and attributed above the job key`,
  };
}

// ---------------------------------------------------------------------------
// Pure predicate: the committed justfile `mutate-server cap=` default EQUALS the
// wiring-eval ceiling MUTATE_SERVER_CAP_BASELINE. Returns { ok, reason }.
//
// WHY THIS EXISTS ALONGSIDE mutateServerRecipeIntact (ADR-0137 D4): that
// predicate only asserts `cap ≤ MUTATE_SERVER_CAP_BASELINE`, so raising the
// CEILING alone is invisible — no eval output changes — and a later slice could
// then raise the justfile cap into the fresh headroom with no eval diff at all.
// Pinning EQUALITY makes the two numbers one number: they move together, in the
// same commit, or this check goes red.
// The reason names BOTH numbers so a red tells you which side drifted.
export function justfileCapEqualsCeiling(justfileText) {
  const headerLine = findMutateServerHeaderLine(justfileText);
  if (headerLine === null) {
    return {
      ok: false,
      reason:
        'justfile has no `mutate-server` recipe header at column 0 — nothing to ' +
        `compare against MUTATE_SERVER_CAP_BASELINE=${MUTATE_SERVER_CAP_BASELINE}`,
    };
  }
  const capInfo = parseCapDefaultFromHeader(headerLine);
  if (!capInfo.present) {
    return {
      ok: false,
      reason:
        'justfile `mutate-server` header declares no cap= default, so the ceiling ' +
        `MUTATE_SERVER_CAP_BASELINE=${MUTATE_SERVER_CAP_BASELINE} has nothing to equal`,
    };
  }
  if (capInfo.cap === null) {
    return {
      ok: false,
      reason:
        'justfile `mutate-server` cap= default is malformed (no digits after cap=), ' +
        `so it cannot equal MUTATE_SERVER_CAP_BASELINE=${MUTATE_SERVER_CAP_BASELINE}`,
    };
  }
  if (capInfo.cap !== MUTATE_SERVER_CAP_BASELINE) {
    return {
      ok: false,
      reason:
        `justfile mutate-server cap=${capInfo.cap} but the wiring-eval ceiling ` +
        `MUTATE_SERVER_CAP_BASELINE=${MUTATE_SERVER_CAP_BASELINE} — ADR-0137 D4 requires ` +
        'them to be EQUAL and to move in the same commit',
    };
  }
  return {
    ok: true,
    reason:
      `justfile mutate-server cap=${capInfo.cap} === ` +
      `MUTATE_SERVER_CAP_BASELINE=${MUTATE_SERVER_CAP_BASELINE}`,
  };
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
  // CAP BOUNDARY FIXTURES ARE DERIVED FROM THE CONSTANT, NEVER HARD-CODED (14r-a).
  // The cap is re-baselined upward from time to time (ADR-0118 §4, ADR-0137 D4).
  // Hard-coded boundary fixtures (the old 299 / 300 / 309 literals) INVERT on the
  // next re-baseline: the "accept at the ceiling" fixture goes vacuous (it sits far
  // below the new ceiling) and the two "reject" fixtures start asserting the wrong
  // side of the boundary — at which point a `>` → `>=` mutant at the cap comparison
  // survives this ENTIRE block. Deriving every boundary fixture from
  // MUTATE_SERVER_CAP_BASELINE keeps the bites pinned to the boundary wherever it
  // moves, so a re-baseline is a one-line constant edit and nothing else.
  const capFixture = (cap) =>
    `mutate-server cap="${cap}":\n    cargo mutants -p monster-realm-module --test-tool nextest --cap {{cap}} 2>&1 | tee missed.txt\n`;
  const CAP_UNDER = MUTATE_SERVER_CAP_BASELINE - 1;
  const CAP_AT = MUTATE_SERVER_CAP_BASELINE;
  const CAP_OVER = MUTATE_SERVER_CAP_BASELINE + 1;
  const CAP_WAY_OVER = MUTATE_SERVER_CAP_BASELINE + 10;

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
  // Bad: cap=9999 (absurdly above any plausible re-baseline of the ceiling).
  // Kept as a literal on purpose: it is the "someone typed a number to make the
  // gate shut up" fixture, not a boundary bite (the boundary bites are derived).
  const justfileMutServerBigCap = `mutate-server cap="9999":\n    cargo mutants -p monster-realm-module --cap {{cap}} > missed.txt\n`;
  if (mutateServerRecipeIntact(justfileMutServerBigCap)) {
    return {
      name,
      pass: false,
      detail:
        `TEETH L-bigcap: mutateServerRecipeIntact accepted cap=9999 (must reject cap > ` +
        `MUTATE_SERVER_CAP_BASELINE=${MUTATE_SERVER_CAP_BASELINE} per ADR-0137 D4 / ADR-0118)`,
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
  // cap ≤ MUTATE_SERVER_CAP_BASELINE, no scope-narrowing flags). cap=150 stays a
  // literal on purpose: it is the "ordinary recipe" control, not a boundary bite.
  const justfileMutServerGood = `mutate-server cap="150":\n    cargo mutants -p monster-realm-module --test-tool nextest --cap {{cap}} 2>&1 | tee missed.txt\n`;
  if (!mutateServerRecipeIntact(justfileMutServerGood)) {
    return {
      name,
      pass: false,
      detail: 'TEETH L-good: mutateServerRecipeIntact rejected a correct mutate-server recipe',
    };
  }
  // Bad: cap = CEILING + 10 — a materially loosened ceiling (was the literal 309
  // fixture against a 299 ceiling). Same intent, now re-pointed: ADR-0137 amends
  // ADR-0118 A3 by tightening the ceiling from 340 to the committed justfile cap, so
  // an impl that still carries ANY slack above the constant (the old 340, or a
  // re-baselined constant that someone padded) accepts a double-digit loosening of
  // the nightly survivor tolerance with no eval-visible signal.
  // NOTE: this fixture was ORIGINALLY asserted ACCEPTED (ceiling was 340); it flipped
  // to REJECTED under spec §ptc5d-4 / ADR-0137 D4. That flip is exactly the hazard the
  // derivation removes — a literal cannot follow the boundary, so it must be derived.
  const justfileMutServerRecap = capFixture(CAP_WAY_OVER);
  if (mutateServerRecipeIntact(justfileMutServerRecap)) {
    return {
      name,
      pass: false,
      detail:
        `TEETH L-recap: mutateServerRecipeIntact accepted cap=${CAP_WAY_OVER} — exceeds the ` +
        `ceiling MUTATE_SERVER_CAP_BASELINE=${MUTATE_SERVER_CAP_BASELINE} (ADR-0137 amends ` +
        'ADR-0118 A3; the ceiling IS the committed justfile cap so every cap move is ' +
        'eval-visible; kills an impl that keeps headroom above the constant)',
    };
  }

  // Bad: cap = CEILING + 1 — the +1 boundary bite (was the literal 300 fixture).
  // Kills: an impl that compares against a looser number than the constant, or drops
  // the comparison entirely. (The `>` → `>=` mutant is killed by the CEILING-accept
  // tooth immediately below, not by this one — the two are a matched pair and only
  // stay a pair while BOTH are derived from MUTATE_SERVER_CAP_BASELINE.)
  const justfileMutServerOvercap = capFixture(CAP_OVER);
  if (mutateServerRecipeIntact(justfileMutServerOvercap)) {
    return {
      name,
      pass: false,
      detail:
        `TEETH L-overcap: mutateServerRecipeIntact accepted cap=${CAP_OVER} — must be rejected ` +
        `by the ceiling MUTATE_SERVER_CAP_BASELINE=${MUTATE_SERVER_CAP_BASELINE} (ADR-0137 D4); ` +
        'this is the +1 boundary bite; kills an impl comparing against a looser constant',
    };
  }

  // Good: cap = CEILING exactly — must be ACCEPTED, not rejected (was the literal 299
  // fixture). Guards the > vs >= off-by-one: an impl using
  // `cap >= MUTATE_SERVER_CAP_BASELINE` rejects the committed default and this fires.
  // This is THE tooth that a re-baseline would have silently defanged as a literal.
  const justfileMutServerAtCeiling = capFixture(CAP_AT);
  if (!mutateServerRecipeIntact(justfileMutServerAtCeiling)) {
    return {
      name,
      pass: false,
      detail:
        `TEETH L-at-ceiling: mutateServerRecipeIntact rejected cap=${CAP_AT} — the committed ` +
        'justfile default equals MUTATE_SERVER_CAP_BASELINE and must be accepted (the check is ' +
        'cap > MUTATE_SERVER_CAP_BASELINE, not cap >= MUTATE_SERVER_CAP_BASELINE); ' +
        'kills the >= off-by-one mutant',
    };
  }

  // Good: cap = CEILING - 1 — just inside the boundary (14r-a addition, completing the
  // derived boundary quartet CEILING-1 accept / CEILING accept / CEILING+1 reject /
  // 9999 reject). Kills an impl that rejects everything at or near the ceiling (e.g.
  // an inverted comparison `cap < X` that would otherwise look green on the real file).
  const justfileMutServerUnderCeiling = capFixture(CAP_UNDER);
  if (!mutateServerRecipeIntact(justfileMutServerUnderCeiling)) {
    return {
      name,
      pass: false,
      detail:
        `TEETH L-under-ceiling: mutateServerRecipeIntact rejected cap=${CAP_UNDER} — one BELOW ` +
        `MUTATE_SERVER_CAP_BASELINE=${MUTATE_SERVER_CAP_BASELINE} is comfortably legal; ` +
        'kills an impl with an inverted or off-by-one cap comparison',
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
  // 14r-a PROOF-OF-TEETH
  // =========================================================================

  // --- TEETH M: jobHasFailurePolicyComment ---
  // Every M-fixture below is a plausible thing a hurried author would actually
  // write; each one names the false-green it kills.

  // M1 — no preamble at all above `coverage:`.
  // Kills: an impl that returns ok for any job it can find (presence ≠ policy).
  const nightlyPolicyNone = `name: Nightly
on:
  workflow_dispatch:
jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyNone, 'coverage');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH M1: jobHasFailurePolicyComment accepted a coverage job with NO comment preamble ' +
          'at all — job presence is not a documented failure policy',
      };
    }
  }

  // M2a — preamble mentions the backticked job name and a routing keyword but
  // never says "failure policy for". Kills: an impl that only greps for the job
  // name plus a keyword (any incidental sentence about the job would pass).
  const nightlyPolicyNoPhrase = `name: Nightly
on:
  workflow_dispatch:
jobs:
  # The \`coverage\` job enforces the vitest line threshold; a red run is picked
  # up as the next slice in the milestone queue.
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyNoPhrase, 'coverage');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH M2a: jobHasFailurePolicyComment accepted a preamble with the backticked job ' +
          'name + a routing keyword but NO "failure policy for" phrase — kills an impl that ' +
          'greps for name+keyword instead of the anchored phrase',
      };
    }
  }

  // M2b — anchored phrase present, routing keyword absent. Kills: an impl that
  // drops clause 5, letting "we know it can fail" count as a policy.
  const nightlyPolicyNoRouting = `name: Nightly
on:
  workflow_dispatch:
jobs:
  # Failure policy for \`coverage\`: the on-call human triages the run the same
  # morning and records the outcome in the nightly log.
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyNoRouting, 'coverage');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH M2b: jobHasFailurePolicyComment accepted a preamble with the anchored phrase ' +
          'but NO routing keyword (next slice / queue / priority) — a policy that never says ' +
          'where the failure goes is not a policy',
      };
    }
  }

  // M2c — "failure policy" + routing keyword, but NO backticked job name anywhere.
  // Kills: an impl that checks clause 4 as two independent substring tests
  // ("failure policy" somewhere AND the name somewhere) rather than one anchored
  // phrase. This is what proves the ATTRIBUTION half of clause 4 is enforced on
  // its own, independently of M3's cross-preamble case.
  const nightlyPolicyUnattributed = `name: Nightly
on:
  workflow_dispatch:
jobs:
  # Failure policy: any failure is inserted as the next slice in the milestone
  # queue (same tier as fix-red-master).
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyUnattributed, 'coverage');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH M2c: jobHasFailurePolicyComment accepted an UNATTRIBUTED "Failure policy:" ' +
          'preamble (no backticked job name at all) — the phrase must name THIS job, or a ' +
          'single generic sentence pasted above one job would cover jobs it never mentions',
      };
    }
  }

  // M3 — mis-attribution ACROSS preambles: a perfect preamble above `mutation:`,
  // nothing above `coverage:`. Kills: any whole-file scan — the classic
  // "one job documented, gate green for all" false pass. Two assertions, one fixture.
  const nightlyPolicyMutationOnly = `name: Nightly
on:
  workflow_dispatch:
jobs:
  # Failure policy for \`mutation\`: a surviving mutant is inserted as the NEXT
  # slice in the milestone queue.
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  {
    const rMutation = jobHasFailurePolicyComment(nightlyPolicyMutationOnly, 'mutation');
    if (!rMutation.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH M3-good-leg: jobHasFailurePolicyComment rejected the correctly documented mutation job in the mis-attribution fixture: ${rMutation.reason}`,
      };
    }
    const rCoverage = jobHasFailurePolicyComment(nightlyPolicyMutationOnly, 'coverage');
    if (rCoverage.ok) {
      return {
        name,
        pass: false,
        detail:
          "TEETH M3: jobHasFailurePolicyComment credited the mutation job's failure policy to " +
          'the undocumented coverage job — kills any whole-file (rather than per-preamble) scan',
      };
    }
  }

  // M3b — substring bleed: the preamble above `mutation:` is anchored on the
  // NEIGHBOURING `mutation-server` job. Kills: an impl that matches the bare job
  // name without the closing backtick+colon (`mutation` ⊂ `mutation-server`).
  const nightlyPolicyBleed = `name: Nightly
on:
  workflow_dispatch:
jobs:
  # Failure policy for \`mutation-server\`: a survivor-count regression is
  # inserted as the next slice in the milestone queue.
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyBleed, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH M3b: jobHasFailurePolicyComment let a `mutation-server` policy satisfy the ' +
          '`mutation` job — the anchored phrase must include the closing backtick and colon ' +
          'so `mutation` cannot match inside `mutation-server`',
      };
    }
  }

  // M3c — cross-attribution WITHIN one preamble (the highest-value tooth): the
  // preamble above `mutation-server:` mentions the backticked job name in
  // unrelated prose on one line, and carries ANOTHER job's anchored policy
  // (plus a routing keyword) on a different line. Kills: an impl that joins the
  // preamble into one blob before searching — the blob contains "failure policy
  // for", the backticked name, and a keyword, so it passes while this job's
  // policy is in fact undocumented.
  const nightlyPolicyCrossAttributed = `name: Nightly
on:
  workflow_dispatch:
jobs:
  # The \`mutation-server\` job shells cargo-mutants over the server crate.
  # Failure policy for \`mutation\`: a surviving mutant is inserted as the next
  # slice in the milestone queue.
  mutation-server:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-server
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyCrossAttributed, 'mutation-server');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH M3c: jobHasFailurePolicyComment accepted a preamble that documents ANOTHER ' +
          "job's failure policy while merely name-dropping `mutation-server` on a different " +
          'line — the phrase and the backticked job name must be on the SAME line (kills an ' +
          'impl that joins the preamble lines into one blob)',
      };
    }
  }

  // M4 — non-contiguous: a perfect preamble separated from the key by ONE BLANK
  // LINE. Kills: an impl that scans "the comments somewhere above" instead of the
  // contiguous preamble; a blank line means the comment belongs to the previous
  // job (that is exactly how the smoke-republish precedent reads).
  const nightlyPolicyDetached = `name: Nightly
on:
  workflow_dispatch:
jobs:
  # Failure policy for \`coverage\`: a threshold breach is inserted as the next
  # slice in the milestone queue.

  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyDetached, 'coverage');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH M4: jobHasFailurePolicyComment accepted a policy comment separated from the ' +
          'coverage key by a blank line — the preamble must be CONTIGUOUS with the key',
      };
    }
  }

  // M5 — in-block placement, two legs.
  // (i) 6-space indent INSIDE the mutation-server block: the comment sits in the
  //     steps list, not above the key. Kills: an impl that searches the job BLOCK
  //     (extractJobBlock) instead of the lines above the key.
  const nightlyPolicyInBlockDeep = `name: Nightly
on:
  workflow_dispatch:
jobs:
  mutation-server:
    runs-on: ubuntu-latest
    steps:
      # Failure policy for \`mutation-server\`: a survivor-count regression is
      # inserted as the next slice in the milestone queue.
      - run: just mutate-server
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyInBlockDeep, 'mutation-server');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH M5-i: jobHasFailurePolicyComment accepted a policy comment placed INSIDE the ' +
          'mutation-server steps list (6-space indent) — the preamble must sit ABOVE the job key',
      };
    }
  }
  // (ii) the same comment at 2-space indent inside the block. The predicate must
  //      still be FALSE (it walks UP from the key, so it never sees this), and —
  //      documented here because it is genuinely surprising — a 2-space comment
  //      inside a job block TRUNCATES extractJobBlock: indent === 2 is the
  //      block-terminator rule, so the `- run:` step below it falls outside the
  //      block and nightlyHasServerMutationJob goes false. Anyone who "fixes" the
  //      preamble walk by relaxing indent to >= 2 must confront this pair.
  const nightlyPolicyInBlockShallow = `name: Nightly
on:
  workflow_dispatch:
jobs:
  mutation-server:
    runs-on: ubuntu-latest
    steps:
  # Failure policy for \`mutation-server\`: a survivor-count regression is
  # inserted as the next slice in the milestone queue.
      - run: just mutate-server
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyInBlockShallow, 'mutation-server');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH M5-ii: jobHasFailurePolicyComment accepted a 2-space policy comment placed ' +
          'INSIDE the mutation-server block — the preamble must sit ABOVE the job key',
      };
    }
    if (nightlyHasServerMutationJob(nightlyPolicyInBlockShallow) !== false) {
      return {
        name,
        pass: false,
        detail:
          'TEETH M5-ii-extract: a 2-space comment inside the mutation-server block must ' +
          'TRUNCATE extractJobBlock (indent === 2 terminates the block), so ' +
          'nightlyHasServerMutationJob must go false — if it did not, the block-extraction ' +
          'contract this eval relies on has changed and every job-block check needs re-review',
      };
    }
  }

  // M6 — commented-out key `  # coverage:` with a perfect preamble above it and no
  // real coverage job. Kills: an impl that matches the job key with a loose
  // `indexOf('coverage:')`, which would "find" the key inside the comment and then
  // credit the (real, perfect) preamble above it.
  const nightlyPolicyCommentedKey = `name: Nightly
on:
  workflow_dispatch:
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
  # Failure policy for \`coverage\`: a threshold breach is inserted as the next
  # slice in the milestone queue.
  # coverage:
  #   runs-on: ubuntu-latest
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyCommentedKey, 'coverage');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH M6: jobHasFailurePolicyComment accepted a COMMENTED-OUT `# coverage:` key — a ' +
          'disabled job with a lovely policy comment above it is the worst false green available',
      };
    }
    if (r.reason.indexOf('job key absent') === -1) {
      return {
        name,
        pass: false,
        detail: `TEETH M6-reason: jobHasFailurePolicyComment rejected the commented-out key for the WRONG reason — it must report the key-absent clause, not a missing phrase. Got: ${r.reason}`,
      };
    }
  }

  // M7 — header bleed: a perfect anchored policy sentence for `coverage` sits in
  // the FILE'S top indent-0 comment block, nothing above the real key. Kills: an
  // impl that walks up ignoring indent (it would sail past `jobs:`/`on:`/`name:`
  // only if it also ignored non-comment lines — but a `# …` at indent 0 directly
  // above a key is the realistic shape once someone moves the file header around).
  const nightlyPolicyHeaderBleed = `# Nightly mutation + coverage gates (ADR-0050).
# Failure policy for \`coverage\`: a threshold breach is inserted as the next
# slice in the milestone queue.
name: Nightly
on:
  workflow_dispatch:
jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyHeaderBleed, 'coverage');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH M7: jobHasFailurePolicyComment accepted a policy sentence living in the FILE ' +
          "header comment block — a file-level comment is not the job's preamble",
      };
    }
  }

  // M8 — `jobs:` anchoring: a decoy 2-space `coverage:` key under `env:` carries a
  // perfect preamble; the REAL coverage job under `jobs:` has none. Kills: an impl
  // that finds the FIRST `  coverage:` line in the file (clause 1 exists for this).
  const nightlyPolicyAboveJobs = `name: Nightly
on:
  workflow_dispatch:
env:
  # Failure policy for \`coverage\`: a threshold breach is inserted as the next
  # slice in the milestone queue.
  coverage: enabled
jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyAboveJobs, 'coverage');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH M8: jobHasFailurePolicyComment was satisfied by a documented `coverage:` key ' +
          'under `env:` while the real job under `jobs:` is undocumented — the key scan must be ' +
          'anchored at the top-level `jobs:` line',
      };
    }
  }

  // M-good-1 — three jobs, three correct preambles: all three must be ok.
  const nightlyPolicyAllThree = `name: Nightly
on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:
jobs:
  # Failure policy for \`mutation\`: a surviving mutant is inserted as the NEXT
  # slice in the milestone queue (same tier as fix-red-master).
  mutation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v4
      - run: just mutate-core
  # Failure policy for \`mutation-server\`: a survivor-count regression is
  # inserted as the next slice in the milestone queue.
  mutation-server:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v4
      - run: just mutate-server
  # Failure policy for \`coverage\`: a threshold breach is inserted as the next
  # slice in the milestone queue.
  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v4
      - run: just coverage
`;
  for (const job of ['mutation', 'mutation-server', 'coverage']) {
    const r = jobHasFailurePolicyComment(nightlyPolicyAllThree, job);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH M-good-1 (${job}): jobHasFailurePolicyComment rejected a correctly documented job — false negative would make the whole gate un-satisfiable. Reason: ${r.reason}`,
      };
    }
  }

  // M-good-2 — multi-line preamble: the anchored phrase is on line 1 (with
  // irregular internal spacing and a tab) and the routing keyword is on line 3.
  // Proves normalisation collapses whitespace and that the keyword may live on a
  // DIFFERENT line from the phrase (clause 5 is preamble-wide, clause 4 is not).
  const nightlyPolicyIrregular = `name: Nightly
on:
  workflow_dispatch:
jobs:
  #   Failure   policy   for \`coverage\`:\tthe run is triaged the same morning.
  # The outcome is recorded in the nightly log.
  # The fix is scheduled as the next slice.
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyIrregular, 'coverage');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH M-good-2: jobHasFailurePolicyComment rejected a valid multi-line preamble with collapsed whitespace/tab in the phrase and the routing keyword on a later line. Reason: ${r.reason}`,
      };
    }
  }

  // M-good-3 — neighbour control: adding policy preambles must not disturb block
  // extraction for ANY of the three jobs. Kills: a "fix" that inserts the comments
  // at an indent which truncates extractJobBlock (see M5-ii) — the policy would be
  // documented and the job silently unrun.
  for (const [job, present] of [
    ['mutation', nightlyHasMutationJob(nightlyPolicyAllThree)],
    ['mutation-server', nightlyHasServerMutationJob(nightlyPolicyAllThree)],
    ['coverage', nightlyHasCoverageJob(nightlyPolicyAllThree)],
  ]) {
    if (!present) {
      return {
        name,
        pass: false,
        detail: `TEETH M-good-3 (${job}): the 2-space policy preambles broke job-step detection — comments above a job key must not affect extractJobBlock`,
      };
    }
  }
  for (const job of ['mutation', 'mutation-server', 'coverage']) {
    const r = jobIsNotNeutered(nightlyPolicyAllThree, job);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH M-good-3-neuter (${job}): jobIsNotNeutered went false on a documented, unneutered job — the preamble comments must not leak into the job block. Reason: ${r.reason}`,
      };
    }
  }

  // --- TEETH N: justfileCapEqualsCeiling ---
  // Fixture caps are DERIVED from MUTATE_SERVER_CAP_BASELINE (see the TEETH L
  // note): a hard-coded literal here would silently invert on the next re-baseline.

  // N1 — cap one BELOW the ceiling → FALSE. This is the invisible-drift case:
  // mutateServerRecipeIntact accepts it happily (cap ≤ ceiling), so without the
  // equality gate a slice could raise the CEILING alone with ZERO eval diff, and a
  // later slice could raise the justfile cap into the fresh headroom — also with
  // zero eval diff. Kills: an impl that reuses the `≤` comparison.
  {
    const r = justfileCapEqualsCeiling(capFixture(CAP_UNDER));
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          `TEETH N1: justfileCapEqualsCeiling accepted cap=${CAP_UNDER} against ceiling ` +
          `${MUTATE_SERVER_CAP_BASELINE} — a cap BELOW the ceiling is exactly the invisible ` +
          'drift ADR-0137 D4 forbids; the predicate must assert EQUALITY, not ≤',
      };
    }
    const namesBoth =
      r.reason.indexOf(String(CAP_UNDER)) !== -1 &&
      r.reason.indexOf(String(MUTATE_SERVER_CAP_BASELINE)) !== -1;
    if (!namesBoth) {
      return {
        name,
        pass: false,
        detail: `TEETH N1-reason: justfileCapEqualsCeiling's reason must name BOTH numbers (justfile cap ${CAP_UNDER} and ceiling ${MUTATE_SERVER_CAP_BASELINE}) so a red says which side drifted. Got: ${r.reason}`,
      };
    }
  }

  // N2 — cap exactly at the ceiling → TRUE (the committed state; if this fails the
  // gate is un-satisfiable and the real-file check is a permanent false red).
  {
    const r = justfileCapEqualsCeiling(capFixture(CAP_AT));
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH N2: justfileCapEqualsCeiling rejected cap=${CAP_AT} which EQUALS MUTATE_SERVER_CAP_BASELINE — this is the committed, correct state. Reason: ${r.reason}`,
      };
    }
  }

  // N3 — cap one ABOVE the ceiling → FALSE. mutateServerRecipeIntact already
  // rejects this; asserting it here too keeps the two views of the number aligned
  // (kills an impl that only checks "cap is not lower than the ceiling").
  {
    const r = justfileCapEqualsCeiling(capFixture(CAP_OVER));
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          `TEETH N3: justfileCapEqualsCeiling accepted cap=${CAP_OVER} against ceiling ` +
          `${MUTATE_SERVER_CAP_BASELINE} — equality means equality in both directions`,
      };
    }
    const namesBoth =
      r.reason.indexOf(String(CAP_OVER)) !== -1 &&
      r.reason.indexOf(String(MUTATE_SERVER_CAP_BASELINE)) !== -1;
    if (!namesBoth) {
      return {
        name,
        pass: false,
        detail: `TEETH N3-reason: justfileCapEqualsCeiling's reason must name BOTH numbers (justfile cap ${CAP_OVER} and ceiling ${MUTATE_SERVER_CAP_BASELINE}). Got: ${r.reason}`,
      };
    }
  }

  // N4 — header with `cap=` but no digits → FALSE. Kills: an impl whose parse
  // returns NaN (NaN !== ceiling is true by accident) or 0-defaults, and an impl
  // that treats an unparseable header as "nothing to compare, therefore fine".
  const justfileCapMalformed = `mutate-server cap=:\n    cargo mutants -p monster-realm-module --test-tool nextest 2>&1 | tee missed.txt\n`;
  {
    const r = justfileCapEqualsCeiling(justfileCapMalformed);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH N4: justfileCapEqualsCeiling accepted a malformed `cap=` header (no digits) — ' +
          'an unparseable cap cannot be proven equal to the ceiling and must be rejected',
      };
    }
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
  // missed.txt, cap ≤ MUTATE_SERVER_CAP_BASELINE, and no --shard/--file/--exclude-re.
  if (!mutateServerRecipeIntact(justfile)) {
    return {
      name,
      pass: false,
      detail:
        'justfile mutate-server recipe is absent or incomplete (EXPECTED RED — implementer must add the recipe: cargo mutants -p monster-realm-module --test-tool nextest with missed.txt count-compare, cap ≤ MUTATE_SERVER_CAP_BASELINE, no --shard/--file/--exclude-re)',
    };
  }

  // =========================================================================
  // 14r-a REAL FILE CHECKS
  //   Check 14/15/16 → EXPECTED RED (no job carries a policy preamble yet)
  //   Check 17       → GREEN today, load-bearing from now on
  // =========================================================================

  // Checks 14–16: each guarded nightly job documents its OWN failure policy in the
  // comment preamble directly above its job key (the smoke-republish precedent at
  // .github/workflows/nightly.yml:78-83). Three SEPARATE checks, each passing its
  // OWN job name — one loop variable copied into all three would leave two jobs
  // unpinned, so the job name is spelled out per check and echoed in the detail.
  //
  // GREEN edit (per job): insert, immediately above the job key at 2-space indent,
  // a comment preamble containing a line of the form
  //   # Failure policy for `<job>`: … next slice / queue / priority …
  // Decision-hook mdrewt/claude-harness#14 is OPEN — do NOT add a notification
  // Action; the documented policy is the reversible default.

  // Check 14: mutation job failure policy (EXPECTED RED)
  {
    const r = jobHasFailurePolicyComment(nightlyYml, 'mutation');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `nightly.yml job 'mutation' has no documented failure policy above its job key (EXPECTED RED): ${r.reason}`,
      };
    }
  }

  // Check 15: mutation-server job failure policy (EXPECTED RED)
  {
    const r = jobHasFailurePolicyComment(nightlyYml, 'mutation-server');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `nightly.yml job 'mutation-server' has no documented failure policy above its job key (EXPECTED RED): ${r.reason}`,
      };
    }
  }

  // Check 16: coverage job failure policy (EXPECTED RED)
  {
    const r = jobHasFailurePolicyComment(nightlyYml, 'coverage');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `nightly.yml job 'coverage' has no documented failure policy above its job key (EXPECTED RED): ${r.reason}`,
      };
    }
  }

  // Check 17: the committed justfile cap EQUALS the wiring-eval ceiling (ADR-0137
  // D4). GREEN today; it goes red the instant either number moves alone, which is
  // the whole point — `mutateServerRecipeIntact`'s `cap ≤ ceiling` cannot see a
  // ceiling-only raise.
  {
    const r = justfileCapEqualsCeiling(justfile);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `justfile mutate-server cap= default and the wiring-eval ceiling have drifted apart: ${r.reason}`,
      };
    }
  }

  return {
    name,
    pass: true,
    detail:
      'nightly smoke-republish correctly wired: job exists in nightly.yml (not ci.yml), references smoke-republish.sh, justfile recipe present, script committed, ADR-0079 documents the failure policy; m13.5a additions: mutation/coverage/mutation-server jobs present and unneutered, schedule+dispatch triggers live, coverage threshold ≥96, mutate-server recipe intact; 14r-a additions: all three guarded jobs document an attributed failure policy in their comment preamble, and the justfile mutate-server cap= default equals MUTATE_SERVER_CAP_BASELINE',
  };
}
