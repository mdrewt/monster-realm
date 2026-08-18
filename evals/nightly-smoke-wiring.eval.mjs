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
//     mirroring the smoke-republish precedent at .github/workflows/nightly.yml:85-90
//     (decision-hook mdrewt/claude-harness#14 — notification channel — is still open,
//     so the reversible default is a documented policy, NOT a notification Action)
//   - the committed justfile `mutate-server cap=` default EQUALS the wiring-eval
//     ceiling MUTATE_SERVER_CAP_BASELINE (ADR-0137 D4: both move in the same commit;
//     the pre-existing `cap ≤ ceiling` check alone makes a ceiling-only raise invisible)
//   - the `mutate-server` recipe carries an explicit `[ ! -f mutants.out/missed.txt ]`
//     existence guard (ADR-0183 D7 — without it an absent missed.txt makes the ratchet
//     block set -e-exempt and skipped, so the gate exits 0 having measured nothing)
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
//   Check 13 also carries the new ADR-0183 D7 missed.txt-guard clause; the committed
//   recipe already has that guard, so Check 13 stays GREEN — the clause is a ratchet
//   against REMOVING it, not a demand for new work.
//
// EXPECTED REAL-TREE STATE AT RED (lp-03 additions — ADR-0200 nightly failure
// notification: a `notify` job per ADR-0200 D1/D2/D2a/D3-D8, mutants.out
// upload-on-failure per D7, and a step-scoped `jobIsNotNeutered` carve-out per D8):
//   None of the five brand-new predicates this slice's teeth call
//   (mutationJobUploadsMutantsOutOnFailure, notifyArtifactNamesAreDistinct,
//   nightlyNotifyCanOpenIssues, noOtherJobHoldsIssuesWrite, nightlyNotifyIsWired) exist in
//   this file yet, and jobIsNotNeutered has NOT yet been rewritten with the ADR-0200 D8
//   step-scoped carve-out (it is still today's flat line scan, which flags ANY `if:` line
//   anywhere in the job block, including a legitimate `if: always()` on an upload step).
//   Consequence: the eval REDs at TEETH O1 — the very first carve-out fixture — because
//   today's jobIsNotNeutered rejects the canonical upload step as neutered. It never
//   reaches TEETH P onward, where the undefined new predicates would otherwise throw a
//   ReferenceError. That IS the expected RED, not a defect in the fixtures (the tester does
//   not implement the specialist's predicates).
//   Round 2 (red-team hardening): every positive-control notify body/condition in TEETH
//   Q/R now uses the shared NOTIFY_D2A_IF / NOTIFY_CANONICAL_STEPS constants — the REAL
//   D1/D2/D2a/D5/D6-compliant shape (toJSON(needs) enumeration, per-job attribution, a run
//   link, a zero-enumerated exit 1 guard, and the `!cancelled() && (failure OR skipped)`
//   condition) — so `nightlyNotifyIsWired` is proven satisfiable ONLY by a genuinely
//   compliant notify job, never by a single hardcoded `gh issue create`. TEETH R10-R14 and
//   R3b/R3c are new negative teeth pinning each compliance clause separately; TEETH S4 pins
//   per-job attribution against a whole-file `issues: write` occurrence-count cheat; TEETH
//   P7/P8 and T3 close three MINOR gaps (spoofed uses: values checked directly by
//   mutationJobUploadsMutantsOutOnFailure rather than assumed caught upstream by
//   jobIsNotNeutered; a missing name: key must not compare "distinct" from nothing). None of
//   this moves the RED location — it still REDs at TEETH O1 first.
//   Once the predicates land, the real-file checks read the committed tree as follows:
//   Check 18 mutationJobUploadsMutantsOutOnFailure(nightly, 'mutation')        → FAIL
//            (no upload-artifact step exists in the mutation job yet)
//   Check 19 mutationJobUploadsMutantsOutOnFailure(nightly, 'mutation-server') → FAIL for
//            the identical reason (not reached today — the eval returns at Check 18 first)
//   Check 20 notifyArtifactNamesAreDistinct(nightly)   → FAIL (no upload-artifact steps
//            exist at all yet, so there is nothing to name distinctly) — not reached today
//   Check 21 nightlyNotifyIsWired(nightly)             → FAIL (no `notify:` job exists) —
//            not reached today
//   Check 22 nightlyNotifyCanOpenIssues(nightly)       → FAIL (top-level permissions: is
//            `contents: read` only and there is no `notify:` job) — not reached today
//   Check 23 noOtherJobHoldsIssuesWrite(nightly)       → would PASS in isolation today (no
//            job holds issues: write yet) but the eval never reaches it — Check 18 REDs first
//   All prior checks (1–17) and TEETH A–N are untouched by this slice and stay GREEN.
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
//   - contains an explicit missed.txt EXISTENCE GUARD (`-f mutants.out/missed.txt`),
//     ADR-0183 D7. Proved by execution, not inspection: when the file is absent,
//     `missed=$(grep -c '' mutants.out/missed.txt || true)` leaves missed="" and the
//     following `[ "" -gt N ]` errors INSIDE an if-condition — which `set -e`
//     deliberately exempts — so the ratchet block is skipped and the recipe exits 0,
//     vacuously green. `mutate-core` already carries the same `[ ! -f … ]` guard;
//     without this clause the server ratchet can silently measure nothing.
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
// line (`mutate-server cap="324":`, `cap='324'`, `cap=324` all parse).
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
  // ADR-0183 D7 (14r-a): the ratchet is vacuously green when mutants.out/missed.txt
  // is absent — the `[ "" -gt N ]` error is set -e-exempt inside an if-condition, so
  // the whole ratchet block is skipped and the recipe exits 0. Require the explicit
  // fail-closed existence guard (same shape mutate-core already uses).
  // Clause ORDER matters: this sits AFTER the `missed.txt` clause so the L-no-missed
  // fixture (no missed.txt anywhere) still bites on its own clause rather than here.
  if (body.indexOf('-f mutants.out/missed.txt') === -1) return false;
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
// `smoke-republish` precedent at .github/workflows/nightly.yml:85-90.
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
  // A trailing comment on the mapping key (`jobs:   # all nightly jobs`) is legal
  // YAML, so it is TOLERATED rather than treated as "no jobs: block" — rejecting it
  // would be a confusing false red on a file that is perfectly well documented
  // (decision pinned by teeth M10-tolerated / M10-absent). `startsWith` keeps the
  // match anchored at column 0, so a nested `  jobs:` can never become the anchor.
  let jobsIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln === 'jobs:' || ln.startsWith('jobs: ') || ln.startsWith('jobs:\t')) {
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
  //
  // EVERY mutate-server fixture below also carries the missed.txt existence guard
  // (ADR-0183 D7 clause). That is not decoration: a negative fixture that OMITS the
  // guard would be rejected by the guard clause before its own clause is ever
  // reached, and its tooth would go inert — precisely the L-bigcap failure the
  // red-team found (that fixture also omitted --test-tool nextest, so it never once
  // exercised the cap comparison). Rule for future fixtures: differ from the
  // canonical recipe by EXACTLY ONE property.
  const MISSED_GUARD = '    if [ ! -f mutants.out/missed.txt ]; then exit 1; fi\n';
  const capFixture = (cap) =>
    `mutate-server cap="${cap}":\n    cargo mutants -p monster-realm-module --test-tool nextest --cap {{cap}} 2>&1 | tee missed.txt\n${MISSED_GUARD}`;
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
  // Deliberately WITHOUT the MISSED_GUARD suffix (unlike every other fixture): the
  // guard line names mutants.out/missed.txt, which would satisfy the very clause
  // this tooth removes. The `missed.txt` clause runs BEFORE the guard clause, so
  // this fixture still bites on its own clause.
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
  const justfileMutServerShard = `mutate-server cap="150":\n    cargo mutants -p monster-realm-module --test-tool nextest --cap {{cap}} --shard 1/64 > missed.txt\n${MISSED_GUARD}`;
  if (mutateServerRecipeIntact(justfileMutServerShard)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH L-shard: mutateServerRecipeIntact accepted a mutate-server recipe with --shard (scope-narrowing bypass)',
    };
  }
  // Bad: cap=9999 (absurdly above any plausible re-baseline of the ceiling).
  // 9999 stays a literal on purpose: it is the "someone typed a number to make the
  // gate shut up" ABSOLUTE backstop, not a boundary bite (the boundary bites are
  // derived from the constant and would all move with a re-baseline; this one must
  // not). Built through capFixture so the recipe is canonical in every other
  // respect — the previous hand-written literal omitted `--test-tool nextest`, so it
  // was rejected on the nextest clause and never exercised the cap comparison at
  // all. Red-team proof of the inertness: with the constant AND the justfile both
  // set to 9999 the entire eval went green, i.e. there was no ceiling backstop.
  const justfileMutServerBigCap = capFixture(9999);
  if (mutateServerRecipeIntact(justfileMutServerBigCap)) {
    return {
      name,
      pass: false,
      detail:
        `TEETH L-bigcap: mutateServerRecipeIntact accepted cap=9999 (must reject cap > ` +
        `MUTATE_SERVER_CAP_BASELINE=${MUTATE_SERVER_CAP_BASELINE} per ADR-0137 D4 / ADR-0118)`,
    };
  }
  // L-bigcap-backstop — the backstop needs the constant to stay BELOW 9999, or the
  // fixture above stops exceeding the ceiling and quietly goes inert (that is how
  // the red-team turned the whole eval green: constant 9999 + justfile cap 9999).
  // A survivor cap in the thousands is not a ratchet; refuse to run in that world.
  if (MUTATE_SERVER_CAP_BASELINE >= 9999) {
    return {
      name,
      pass: false,
      detail: `TEETH L-bigcap-backstop: MUTATE_SERVER_CAP_BASELINE=${MUTATE_SERVER_CAP_BASELINE} is at or above the 9999 absolute backstop, which makes the L-bigcap fixture inert (no cap would ever exceed the ceiling). Re-baselining the ratchet that far is not a re-baseline — re-open ADR-0050/ADR-0183 instead`,
    };
  }
  // Bad: --file scope-narrowing bypass.
  const justfileMutServerFile = `mutate-server cap="150":\n    cargo mutants -p monster-realm-module --test-tool nextest --cap {{cap}} --file shop.rs > missed.txt\n${MISSED_GUARD}`;
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
  const justfileMutServerNoNextest = `mutate-server cap="150":\n    cargo mutants -p monster-realm-module --cap {{cap}} 2>&1 | tee missed.txt\n${MISSED_GUARD}`;
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
  const justfileMutServerMalformedCap = `mutate-server cap=:\n    cargo mutants -p monster-realm-module --test-tool nextest 2>&1 | tee missed.txt\n${MISSED_GUARD}`;
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
  const justfileMutServerGood = `mutate-server cap="150":\n    cargo mutants -p monster-realm-module --test-tool nextest --cap {{cap}} 2>&1 | tee missed.txt\n${MISSED_GUARD}`;
  if (!mutateServerRecipeIntact(justfileMutServerGood)) {
    return {
      name,
      pass: false,
      detail: 'TEETH L-good: mutateServerRecipeIntact rejected a correct mutate-server recipe',
    };
  }

  // --- TEETH L-guard: the missed.txt EXISTENCE GUARD clause (ADR-0183 D7) ---
  // Bad: the otherwise-canonical recipe with NO `[ ! -f mutants.out/missed.txt ]`
  // guard — today's shape before hardening. Verified by execution, not inspection:
  // with the file absent, `missed=$(grep -c '' … || true)` yields missed="" and the
  // following `[ "" -gt N ]` errors inside an if-condition, which set -e EXEMPTS, so
  // the ratchet block is skipped and the recipe exits 0 having measured nothing.
  // Kills: an impl that treats "the recipe mentions missed.txt" as proof the count
  // is actually compared — mentioning the file is not reading it.
  const justfileMutServerNoGuard = `mutate-server cap="150":\n    cargo mutants -p monster-realm-module --test-tool nextest --cap {{cap}} 2>&1 | tee missed.txt\n    missed=$(grep -c '' mutants.out/missed.txt || true)\n`;
  if (mutateServerRecipeIntact(justfileMutServerNoGuard)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH L-no-guard: mutateServerRecipeIntact accepted a mutate-server recipe with NO ' +
        'explicit `[ ! -f mutants.out/missed.txt ]` existence guard — without it an absent ' +
        'missed.txt makes the ratchet block set -e-exempt and skipped, so the gate exits 0 ' +
        'vacuously green (ADR-0183 D7; mutate-core already carries the same guard)',
    };
  }
  // Good: the same recipe WITH the guard must still be accepted (proves the new
  // clause is satisfiable and did not just turn the predicate into a constant false).
  const justfileMutServerGuarded = `${justfileMutServerNoGuard}${MISSED_GUARD}`;
  if (!mutateServerRecipeIntact(justfileMutServerGuarded)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH L-guard-good: mutateServerRecipeIntact rejected a recipe that DOES carry the ' +
        'missed.txt existence guard — the ADR-0183 D7 clause must be satisfiable',
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
  const justfileMutServerDashO = `mutate-server cap="150":\n    cargo mutants -p monster-realm-module --test-tool nextest --cap {{cap}} -o /tmp/mutations.txt && wc -l /tmp/mutations.txt > missed.txt\n${MISSED_GUARD}`;
  if (mutateServerRecipeIntact(justfileMutServerDashO)) {
    return {
      name,
      pass: false,
      detail:
        'TEETH F10-dash-o: mutateServerRecipeIntact accepted a mutate-server recipe with `-o /tmp/x` (output redirect) — must ban ` -o ` as a space-delimited token; redirecting output leaves the recipe reading a stale missed.txt',
    };
  }
  // Bad: recipe uses `--output`.
  const justfileMutServerOutput = `mutate-server cap="150":\n    cargo mutants -p monster-realm-module --test-tool nextest --cap {{cap}} --output /tmp/mutations 2>&1 | tee missed.txt\n${MISSED_GUARD}`;
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

  // M2a — preamble mentions the backticked job name FOLLOWED BY A COLON and a
  // routing keyword, but never says "failure policy for".
  // Kills: an impl that drops the whole `failure policy for ` prefix from the
  // anchored phrase (leaving just "`coverage`:").
  // FIXTURE REPAIR (red-team): the original fixture wrote "The `coverage` job
  // enforces …" — backtick then a SPACE, never a colon — so a prefix-dropping mutant
  // still found no match and survived. The colon is what exercises the prefix.
  const nightlyPolicyNoPhrase = `name: Nightly
on:
  workflow_dispatch:
jobs:
  # The \`coverage\`: threshold job. Fixed in the next slice.
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
          'name + colon + a routing keyword but NO "failure policy for" phrase — kills an impl ' +
          'that anchors on "`<job>`:" alone instead of the full phrase',
      };
    }
  }

  // M2a-2 — the same trap one word in: a preamble carrying a DIFFERENT kind of
  // policy for this job, written as "<something> policy for `coverage`:".
  // Kills: an impl that drops only the word "failure" from the anchored phrase
  // (phrase becomes "policy for `coverage`:", which this line satisfies). M2a
  // cannot kill that mutant — it has no "policy for" text at all — so the two
  // fixtures are a pair, one per word of the prefix.
  const nightlyPolicyOtherPolicy = `name: Nightly
on:
  workflow_dispatch:
jobs:
  # Retry policy for \`coverage\`: rerun once, then hand it to the next slice.
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyOtherPolicy, 'coverage');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH M2a-2: jobHasFailurePolicyComment accepted a RETRY policy as a failure policy ' +
          '— the anchored phrase must retain the word "failure"; kills an impl that matches ' +
          'only "policy for `<job>`:"',
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

  // M3d — the LINE-WRAPPED phrase: exactly the shape the clause-4 reason string
  // warns an editor not to write. Kills: a blob-join impl that reads TOP-DOWN, i.e.
  // `preamble.slice().reverse().join(' ')` — the preamble is collected bottom-up, so
  // reversing restores document order and stitches "failure policy for" onto
  // "`coverage`: …", producing the anchored phrase that no single line contains.
  // M3c cannot kill that mutant (its two lines do not concatenate into the phrase in
  // either direction); the two fixtures are a matched pair against blob-joining.
  const nightlyPolicyWrapped = `name: Nightly
on:
  workflow_dispatch:
jobs:
  # Failure policy for
  # \`coverage\`: inserted as the next slice in the queue.
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyWrapped, 'coverage');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH M3d: jobHasFailurePolicyComment accepted a LINE-WRAPPED anchored phrase ' +
          '("Failure policy for" / "`coverage`: …" on two lines) — clause 4 requires the ' +
          'phrase on a SINGLE line; kills a top-down (reversed) blob-join impl',
      };
    }
  }

  // M9 — the trailing COLON is load-bearing. Witness prose that names the job and a
  // routing keyword and even says "failure policy for `coverage`" — but as a
  // statement that no policy exists. Kills: an impl that drops the `:` from the
  // anchored phrase, which would accept this and every other passing mention.
  const nightlyPolicyNoColon = `name: Nightly
on:
  workflow_dispatch:
jobs:
  # There is no agreed failure policy for \`coverage\` yet; see the triage queue.
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyNoColon, 'coverage');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH M9: jobHasFailurePolicyComment accepted "there is no agreed failure policy ' +
          'for `coverage` yet" as a documented policy — the anchored phrase must end in a ' +
          'COLON (the colon is what makes it a declaration rather than a mention)',
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
  // (iii) THE indent-strictness bite. The previous job's LAST line is a 6-space
  //       comment carrying a perfect policy for the NEXT job — a trailing note left
  //       inside `mutation-server`'s steps, immediately above `  coverage:`.
  //       Kills three mutations of the upward-walk guard that M5-i cannot reach
  //       (its fixture has no job key following the in-block comment, so the walk
  //       never starts there): `indent !== 2` → `indent < 2`; → `indent === 0`;
  //       and the guard deleted outright. Each of those keeps walking through the
  //       6-space line, harvests the phrase, and reports a policy that is filed
  //       under someone else's job — while the block-extraction contract (M5-ii)
  //       means such a comment is also where it can truncate a job.
  const nightlyPolicyPrevJobTail = `name: Nightly
on:
  workflow_dispatch:
jobs:
  mutation-server:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-server
      # Failure policy for \`coverage\`: inserted as the next slice in the queue.
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyPrevJobTail, 'coverage');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH M5-iii: jobHasFailurePolicyComment accepted a 6-space comment that belongs to ' +
          "the PREVIOUS job's step list as `coverage`'s preamble — the upward walk must stop " +
          'at any indent other than exactly 2 (kills indent < 2, indent === 0, and the ' +
          'guard removed entirely)',
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

  // M10-tolerated — a trailing comment on the `jobs:` mapping key is legal YAML and
  // is TOLERATED (decision recorded here, not just in the predicate): the jobs are
  // properly documented, so rejecting the file would be a confusing false red. This
  // is a positive control — it pins the tolerance so nobody "simplifies" the anchor
  // back to an exact-equality match and turns a legal workflow red.
  const nightlyPolicyJobsTrailingComment = `name: Nightly
on:
  workflow_dispatch:
jobs:   # all nightly jobs
  # Failure policy for \`coverage\`: a threshold breach is inserted as the next
  # slice in the milestone queue.
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyJobsTrailingComment, 'coverage');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH M10-tolerated: jobHasFailurePolicyComment rejected a correctly documented job because the \`jobs:\` key carries a trailing comment — that is legal YAML and is deliberately tolerated. Reason: ${r.reason}`,
      };
    }
  }

  // M10-absent — no top-level `jobs:` line at all (a workflow fragment, or a file
  // where someone indented the block). The predicate must FAIL CLOSED even though a
  // perfect preamble sits above a 2-space key. Kills: a mutant that returns ok:true
  // from the jobs-anchor-missing branch — the branch M10-tolerated cannot reach.
  const nightlyPolicyNoJobsKey = `name: Nightly
on:
  workflow_dispatch:
  # Failure policy for \`coverage\`: a threshold breach is inserted as the next
  # slice in the milestone queue.
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;
  {
    const r = jobHasFailurePolicyComment(nightlyPolicyNoJobsKey, 'coverage');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH M10-absent: jobHasFailurePolicyComment returned ok for a workflow with NO ' +
          'top-level `jobs:` line — with no anchor there is no proof the documented key is a ' +
          'job at all; this branch must fail closed',
      };
    }
    if (r.reason.indexOf('job key absent') === -1) {
      return {
        name,
        pass: false,
        detail: `TEETH M10-absent-reason: the jobs-anchor-missing branch must report the key-absent clause so the red is diagnosable. Got: ${r.reason}`,
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

  // N5 — header with NO `cap=` parameter at all, body otherwise canonical → FALSE.
  // This is the load-bearing one: mutateServerRecipeIntact DELIBERATELY tolerates an
  // absent cap= ("cap= is optional in the recipe"), so deleting the parameter
  // silently deletes the ratchet — and this predicate is the only thing standing
  // between that and a green eval. Kills: the `!capInfo.present → ok:true` mutant,
  // and the parseCapDefaultFromHeader `capIdx === -1 → {present:true, cap: <the
  // ceiling>}` mutant, which fakes agreement out of an absent parameter.
  const justfileCapNoParam = `mutate-server:\n    cargo mutants -p monster-realm-module --test-tool nextest 2>&1 | tee missed.txt\n${MISSED_GUARD}`;
  {
    const r = justfileCapEqualsCeiling(justfileCapNoParam);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH N5: justfileCapEqualsCeiling accepted a mutate-server header with NO cap= ' +
          'parameter — mutateServerRecipeIntact tolerates an absent cap= by design, so an ' +
          'absent cap= must fail HERE or the cap/ceiling coupling disappears silently',
      };
    }
  }

  // N6 — no `mutate-server` recipe at all → FALSE. Kills: the
  // `headerLine === null → ok:true` mutant. Without this, deleting the whole recipe
  // would satisfy the coupling check (mutateServerRecipeIntact catches the deletion
  // today, but the two predicates must not depend on each other's teeth).
  {
    const r = justfileCapEqualsCeiling(justfileNoMutateServer);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH N6: justfileCapEqualsCeiling accepted a justfile with NO mutate-server recipe ' +
          '— an absent recipe cannot be proven equal to the ceiling and must fail closed',
      };
    }
  }

  // =========================================================================
  // lp-03 PROOF-OF-TEETH (ADR-0200 — nightly failure notification)
  // Section letters continue from the existing TEETH A–N; the pre-existing
  // "TEETH N" above is justfileCapEqualsCeiling (14r-a), so the six new
  // predicate groups below are lettered O–T to avoid colliding with it.
  // The predicates under test (strictJobBlock, jobIsNotNeutered [rewritten],
  // mutationJobUploadsMutantsOutOnFailure, notifyArtifactNamesAreDistinct,
  // nightlyNotifyCanOpenIssues, noOtherJobHoldsIssuesWrite, nightlyNotifyIsWired)
  // do not exist in this file yet — every fixture below is calling forward to
  // code the specialist has not written, which is the deliberate RED.
  // =========================================================================

  // -------------------------------------------------------------------------
  // TEETH O: jobIsNotNeutered's step-scoped upload-artifact carve-out
  // (ADR-0200 D8). Every fixture uses job name 'mutation'.
  // -------------------------------------------------------------------------

  const UPLOAD_USES = 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4';

  // O1 — canonical: run step + upload step with `if: always()`. [ok]
  const oCanonicalAlways = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v4
      - run: just mutate-core
      - name: Upload mutants.out on failure
        if: always()
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-core
          path: mutants.out/
          if-no-files-found: warn
          retention-days: 14
`;
  {
    const r = jobIsNotNeutered(oCanonicalAlways, 'mutation');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH O1: jobIsNotNeutered rejected the canonical upload step with if: always() — the D8 carve-out must be satisfiable. Reason: ${r.reason}`,
      };
    }
  }

  // O2 — canonical, expression form: `if: \${{ always() }}`. [ok]
  const oCanonicalExprAlways = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload mutants.out on failure
        if: \${{ always() }}
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-core
          path: mutants.out/
`;
  {
    const r = jobIsNotNeutered(oCanonicalExprAlways, 'mutation');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH O2: jobIsNotNeutered rejected the upload step with if: \${{ always() }} (expression form) — both spellings of always() must be admitted. Reason: ${r.reason}`,
      };
    }
  }

  // O3 — `if: always()` moved onto the RUN step, valid upload step present without
  // its own if:. Kills: an impl that admits if: always() anywhere in the job once
  // an upload-artifact step exists, instead of requiring the if: to sit ON the
  // upload step itself. [NOT ok]
  const oIfOnRunStep = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - name: Run mutation
        if: always()
        run: just mutate-core
      - name: Upload mutants.out on failure
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-core
          path: mutants.out/
`;
  {
    const r = jobIsNotNeutered(oIfOnRunStep, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH O3: jobIsNotNeutered accepted if: always() on the RUN step merely because a ' +
          'valid upload step exists elsewhere in the job — the carve-out is per-step, not per-job',
      };
    }
  }

  // O4 — adjacency-smuggle: an upload step with no if: sits immediately ABOVE a
  // run step carrying if: false. Kills: an impl that scans "the next if: line
  // after a uses: upload-artifact line" instead of a step's OWN keys, which
  // could misattribute the following step's if: to the upload step. [NOT ok]
  const oAdjacencySmuggle = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - name: Upload mutants.out on failure
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-core
          path: mutants.out/
      - name: Run mutation
        if: false
        run: just mutate-core
`;
  {
    const r = jobIsNotNeutered(oAdjacencySmuggle, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH O4: jobIsNotNeutered accepted a run step with if: false sitting immediately ' +
          'below an upload step — step boundaries must be respected regardless of adjacency',
      };
    }
  }

  // O5 — `if:` on the checkout step (a `uses:` step, but not upload-artifact). [NOT ok]
  const oIfOnCheckout = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        if: always()
        uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v4
      - run: just mutate-core
`;
  {
    const r = jobIsNotNeutered(oIfOnCheckout, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH O5: jobIsNotNeutered accepted if: always() on the checkout step — the ' +
          'carve-out is restricted to a step whose uses: equals actions/upload-artifact exactly',
      };
    }
  }

  // O6 — job-level `if: false`. [NOT ok]
  const oJobLevelIfFalse = `jobs:
  mutation:
    runs-on: ubuntu-latest
    if: false
    steps:
      - run: just mutate-core
`;
  {
    const r = jobIsNotNeutered(oJobLevelIfFalse, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: 'TEETH O6: jobIsNotNeutered accepted a job-level if: false',
      };
    }
  }

  // O7 — upload step with if: always() AND continue-on-error: true. [NOT ok]
  const oUploadAlwaysCoeTrue = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload mutants.out on failure
        if: always()
        continue-on-error: true
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-core
          path: mutants.out/
`;
  {
    const r = jobIsNotNeutered(oUploadAlwaysCoeTrue, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH O7: jobIsNotNeutered accepted an upload step with a legitimate if: always() ' +
          'sitting alongside continue-on-error: true — the allowlist applies even to the upload step',
      };
    }
  }

  // O8 — upload step with if: false. [NOT ok]
  const oUploadIfFalse = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload mutants.out on failure
        if: false
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-core
          path: mutants.out/
`;
  {
    const r = jobIsNotNeutered(oUploadIfFalse, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: 'TEETH O8: jobIsNotNeutered accepted an upload step with if: false',
      };
    }
  }

  // O9 — upload step with if: success(). [NOT ok]
  const oUploadIfSuccess = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload mutants.out on failure
        if: success()
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-core
          path: mutants.out/
`;
  {
    const r = jobIsNotNeutered(oUploadIfSuccess, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH O9: jobIsNotNeutered accepted an upload step with if: success() — only ' +
          'always() (bare or expression form) is admitted',
      };
    }
  }

  // O10 — `uses: evil/upload-artifact@<40hex>` with if: always(). Kills: an impl
  // that matches on the "upload-artifact" suffix instead of full equality. [NOT ok]
  const oEvilUploadArtifact = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload mutants.out on failure
        if: always()
        uses: evil/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: mutants-out-core
          path: mutants.out/
`;
  {
    const r = jobIsNotNeutered(oEvilUploadArtifact, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH O10: jobIsNotNeutered accepted if: always() on a step using ' +
          'evil/upload-artifact — the uses: value must equal actions/upload-artifact exactly',
      };
    }
  }

  // O11 — `uses: actions/upload-artifact-fake@<40hex>`. Kills: an impl that uses
  // indexOf/startsWith instead of exact equality after stripping ref+comment. [NOT ok]
  const oUploadArtifactFake = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload mutants.out on failure
        if: always()
        uses: actions/upload-artifact-fake@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: mutants-out-core
          path: mutants.out/
`;
  {
    const r = jobIsNotNeutered(oUploadArtifactFake, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH O11: jobIsNotNeutered accepted if: always() on ' +
          'actions/upload-artifact-fake — exact equality must reject a lookalike name',
      };
    }
  }

  // O12 — a run step (has its own run: key, so never an upload step) with
  // if: always(), whose body contains a COMMENT LINE mentioning
  // "uses: actions/upload-artifact@…". Kills: an impl that greps the whole step
  // text for the uses: value instead of reading it as a real, own, top-level key. [NOT ok]
  const oCommentUsesInsideRunStep = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - name: Suspicious step
        if: always()
        run: |
          # uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
          echo hi
`;
  {
    const r = jobIsNotNeutered(oCommentUsesInsideRunStep, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH O12: jobIsNotNeutered accepted if: always() on a run: step because a COMMENT ' +
          'line inside its block-scalar body happened to mention uses: actions/upload-artifact — ' +
          'a step with its own run: key can never be an upload step regardless of what its body says',
      };
    }
  }

  // O13 — a step using `run: |` whose block-scalar BODY contains a line that
  // trims to exactly "if: false". This must NOT be treated as a real if: key —
  // block-scalar bodies are DATA. [ok]
  const oBlockScalarDataIfFalse = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Print status
        run: |
          if: false
          echo done
`;
  {
    const r = jobIsNotNeutered(oBlockScalarDataIfFalse, 'mutation');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH O13: jobIsNotNeutered rejected a job whose only "if: false" text lives inside a run: | block-scalar body (data, not a key) — false-red on step body content. Reason: ${r.reason}`,
      };
    }
  }

  // O14 — upload step whose `with:` block carries if-no-files-found / retention-days
  // alongside if: always(). False-red guard: an impl that matches `if:` as a loose
  // substring could trip on `if-no-files-found:`. [ok]
  const oUploadWithBlockFalseRedGuard = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload mutants.out on failure
        if: always()
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-core
          if-no-files-found: warn
          path: mutants.out/
          retention-days: 14
`;
  {
    const r = jobIsNotNeutered(oUploadWithBlockFalseRedGuard, 'mutation');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH O14: jobIsNotNeutered rejected a legitimate upload step whose with: block contains if-no-files-found: — the if: key match must be anchored, not a loose "if" substring test. Reason: ${r.reason}`,
      };
    }
  }

  // O15 — two upload steps, one with if: always() and one with no if: at all. [ok]
  const oTwoUploadsOneWithoutIf = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload A
        if: always()
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-core
          path: mutants.out/
      - name: Upload B
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-core-2
          path: mutants.out/
`;
  {
    const r = jobIsNotNeutered(oTwoUploadsOneWithoutIf, 'mutation');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH O15: jobIsNotNeutered rejected a job with two upload steps (one carrying if: always(), one carrying no if: at all) — both are legitimate. Reason: ${r.reason}`,
      };
    }
  }

  // O16 — job with no `steps:` key at all. Fail-closed. [NOT ok]
  const oNoStepsKey = `jobs:
  mutation:
    runs-on: ubuntu-latest
`;
  {
    const r = jobIsNotNeutered(oNoStepsKey, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH O16: jobIsNotNeutered accepted a job block with no steps: key at all — must fail closed',
      };
    }
  }

  // O17 — THE TRUNCATION ATTACK. A run step, then a 2-space `  # noise` comment
  // (which truncates the OLD extractJobBlock's indent===2 terminator), then a
  // step at 6-space indent carrying if: false hiding below the decoy comment.
  // strictJobBlock must terminate only at a non-blank, NON-comment line at
  // indent <= 2 — so this if: false must still be seen. This tooth is mandatory
  // per ADR-0200 D8 ("own block extraction"). [NOT ok]
  const oTruncationAttack = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
  # noise
      - if: false
        run: echo x
`;
  {
    const r = jobIsNotNeutered(oTruncationAttack, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH O17-truncation: jobIsNotNeutered accepted a job with an if: false step hidden ' +
          'below a 2-space decoy comment — this is the extractJobBlock truncation hole; ' +
          'jobIsNotNeutered must use strictJobBlock, which does not stop at a comment line',
      };
    }
  }

  // O18 — quoted key: job-level `"if": false`. [NOT ok]
  const oQuotedKeyIfFalse = `jobs:
  mutation:
    runs-on: ubuntu-latest
    "if": false
    steps:
      - run: just mutate-core
`;
  {
    const r = jobIsNotNeutered(oQuotedKeyIfFalse, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH O18: jobIsNotNeutered accepted a job-level "if": false (double-quoted key) — ' +
          'key matching must tolerate quoted forms',
      };
    }
  }

  // O19 — spaced key: job-level `if : always()`. [NOT ok]
  const oSpacedKeyIfAlways = `jobs:
  mutation:
    runs-on: ubuntu-latest
    if : always()
    steps:
      - run: just mutate-core
`;
  {
    const r = jobIsNotNeutered(oSpacedKeyIfAlways, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH O19: jobIsNotNeutered accepted a job-level "if : always()" (space before the ' +
          'colon) — key matching must tolerate a space before the colon',
      };
    }
  }

  // O20 — coe expression: `continue-on-error: \${{ github.event_name == 'schedule' }}`
  // — false under workflow_dispatch (what a drill uses), true on every real cron
  // night: a neuter calibrated to hide from its own verification. [NOT ok]
  const oCoeExpression = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - name: Run mutation
        run: just mutate-core
        continue-on-error: \${{ github.event_name == 'schedule' }}
`;
  {
    const r = jobIsNotNeutered(oCoeExpression, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          "TEETH O20: jobIsNotNeutered accepted continue-on-error: ${{ github.event_name == 'schedule' }} " +
          '— the allowlist must accept ONLY the literal `false`, rejecting every expression form ' +
          'even one that evaluates false under the drill trigger',
      };
    }
  }

  // O21 — flow-style step: `- { run: just mutate-core, if: false }`. Fail-closed. [NOT ok]
  const oFlowStyleStep = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - { run: just mutate-core, if: false }
`;
  {
    const r = jobIsNotNeutered(oFlowStyleStep, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH O21: jobIsNotNeutered accepted a flow-style step `- { run: ..., if: false }` — ' +
          'the scanner cannot read flow-mapping steps and must fail closed rather than miss the if:',
      };
    }
  }

  // O22 — flow `steps:` sequence: `steps: [ { run: just mutate-core } ]`. Fail-closed. [NOT ok]
  const oFlowStepsSequence = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps: [ { run: just mutate-core } ]
`;
  {
    const r = jobIsNotNeutered(oFlowStepsSequence, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH O22: jobIsNotNeutered accepted a flow-style `steps: [ ... ]` sequence — the ' +
          'scanner cannot read it and must fail closed',
      };
    }
  }

  // O23a — YAML merge key (<<:) inside the block. Fail-closed. [NOT ok]
  const oMergeKey = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - <<: *defaults
      - run: just mutate-core
`;
  {
    const r = jobIsNotNeutered(oMergeKey, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH O23a: jobIsNotNeutered accepted a job block containing a YAML merge key (<<:) ' +
          '— an unresolvable indirection must fail closed rather than be read as ok',
      };
    }
  }

  // O23b — a bare alias (*name) inside the block. Fail-closed. [NOT ok]
  const oAlias = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - *shared_checkout
      - run: just mutate-core
`;
  {
    const r = jobIsNotNeutered(oAlias, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH O23b: jobIsNotNeutered accepted a job block containing a bare YAML alias ' +
          '(*shared_checkout) — an unresolvable indirection must fail closed',
      };
    }
  }

  // O24 — positive control: `continue-on-error: false` spelled literally is still ok. [ok]
  const oCoeFalseLiteralGood = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - name: Run mutation
        run: just mutate-core
        continue-on-error: false
`;
  {
    const r = jobIsNotNeutered(oCoeFalseLiteralGood, 'mutation');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH O24: jobIsNotNeutered rejected continue-on-error: false (the literal, allowlisted value) — the allowlist must remain satisfiable. Reason: ${r.reason}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // TEETH P: mutationJobUploadsMutantsOutOnFailure (ADR-0200 D7)
  // -------------------------------------------------------------------------

  // P1 — no upload step at all. [NOT ok]
  const pNoUpload = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
`;
  {
    const r = mutationJobUploadsMutantsOutOnFailure(pNoUpload, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH P1: mutationJobUploadsMutantsOutOnFailure accepted a mutation job with no upload step at all',
      };
    }
  }

  // P2 — upload step with NO if: at all. THE LOAD-BEARING CASE: the default is
  // success(), which skips the upload on the only night it matters. [NOT ok]
  const pUploadNoIf = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload mutants.out
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-core
          path: mutants.out/
          if-no-files-found: warn
          retention-days: 14
`;
  {
    const r = mutationJobUploadsMutantsOutOnFailure(pUploadNoIf, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH P2: mutationJobUploadsMutantsOutOnFailure accepted an upload step with NO if: ' +
          'at all — the GitHub default is success(), which silently skips the upload on the ' +
          'one night it matters; absence of if: must be treated as a failure, not a pass',
      };
    }
  }

  // P3 — if: success(). [NOT ok]
  const pUploadIfSuccess = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload mutants.out
        if: success()
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-core
          path: mutants.out/
`;
  {
    const r = mutationJobUploadsMutantsOutOnFailure(pUploadIfSuccess, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH P3: mutationJobUploadsMutantsOutOnFailure accepted an upload step with if: success()',
      };
    }
  }

  // P4 — if: always() but path: coverage/ (wrong artifact directory). [NOT ok]
  const pUploadAlwaysWrongPath = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload mutants.out
        if: always()
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-core
          path: coverage/
`;
  {
    const r = mutationJobUploadsMutantsOutOnFailure(pUploadAlwaysWrongPath, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH P4: mutationJobUploadsMutantsOutOnFailure accepted if: always() with path: coverage/ instead of mutants.out/',
      };
    }
  }

  // P5 — a `uses:` line that only appears inside a COMMENT. [NOT ok]
  const pUsesOnlyInComment = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      # uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
      - name: Fake upload
        if: always()
        run: echo "not really uploading anything"
`;
  {
    const r = mutationJobUploadsMutantsOutOnFailure(pUsesOnlyInComment, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH P5: mutationJobUploadsMutantsOutOnFailure accepted a job where the only ' +
          'mention of actions/upload-artifact is inside a # comment line — the real step is a ' +
          'plain run: step with no uses: key at all',
      };
    }
  }

  // P6 — canonical: if: always(), path: mutants.out/, non-empty name:. [ok]
  const pCanonical = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload mutants.out on failure
        if: always()
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-core
          path: mutants.out/
          if-no-files-found: warn
          retention-days: 14
`;
  {
    const r = mutationJobUploadsMutantsOutOnFailure(pCanonical, 'mutation');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH P6: mutationJobUploadsMutantsOutOnFailure rejected the canonical upload-on-failure step. Reason: ${r.reason}`,
      };
    }
  }

  // P6b — canonical with path: mutants.out (no trailing slash) — the contract
  // explicitly allows both spellings. [ok]
  const pCanonicalNoSlash = `jobs:
  mutation-server:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-server
      - name: Upload mutants.out on failure
        if: always()
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-server
          path: mutants.out
          if-no-files-found: warn
          retention-days: 14
`;
  {
    const r = mutationJobUploadsMutantsOutOnFailure(pCanonicalNoSlash, 'mutation-server');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH P6b: mutationJobUploadsMutantsOutOnFailure rejected path: mutants.out (no trailing slash), which the contract allows. Reason: ${r.reason}`,
      };
    }
  }

  // P7 — spoofed `uses: evil/upload-artifact@<40hex>` with if: always() + path:
  // mutants.out/. This predicate must check uses: DIRECTLY — it must NOT rely on
  // jobIsNotNeutered (a different predicate, tested separately in TEETH O) to
  // have already rejected the spoofed step upstream. [NOT ok]
  const pEvilUploadArtifact = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload mutants.out on failure
        if: always()
        uses: evil/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: mutants-out-core
          path: mutants.out/
`;
  {
    const r = mutationJobUploadsMutantsOutOnFailure(pEvilUploadArtifact, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH P7: mutationJobUploadsMutantsOutOnFailure accepted a step using ' +
          'evil/upload-artifact (not actions/upload-artifact) with if: always() and ' +
          'path: mutants.out/ — this predicate must verify uses: itself, independently of jobIsNotNeutered',
      };
    }
  }

  // P8 — spoofed `uses: actions/upload-artifact-fake@<40hex>` (lookalike name),
  // same shape. [NOT ok]
  const pUploadArtifactFake = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload mutants.out on failure
        if: always()
        uses: actions/upload-artifact-fake@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
        with:
          name: mutants-out-core
          path: mutants.out/
`;
  {
    const r = mutationJobUploadsMutantsOutOnFailure(pUploadArtifactFake, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH P8: mutationJobUploadsMutantsOutOnFailure accepted a step using ' +
          'actions/upload-artifact-fake (lookalike name) with if: always() and path: mutants.out/',
      };
    }
  }

  // -------------------------------------------------------------------------
  // Shared canonical notify-job fragments (ADR-0200 D1/D2/D2a/D5/D6), reused
  // by TEETH Q and TEETH R below. Declared once so every positive control in
  // this file describes the SAME real canonical shape, and so a fixture that
  // deliberately varies exactly one property is visibly a one-property diff
  // from these constants rather than from a hand-copied near-duplicate.
  //
  // NOTIFY_D2A_IF — the job-level condition (ADR-0200 D2a). Plain `if:
  // failure()` never fires when a needed job is merely `skipped` — exactly
  // what a successful job-level neuter looks like at runtime — so the
  // condition must explicitly admit `skipped` alongside `failure`, while
  // staying quiet on a fully green night (protects D6's zero-guard) and not
  // firing on an outright cancellation.
  //
  // NOTIFY_CANONICAL_STEPS — the step body (ADR-0200 D1/D2/D5/D6): enumerates
  // the non-success job set from `toJSON(needs)` via `jq` (never hardcoded),
  // opens one `gh issue create` per enumerated job with the job name AND a
  // run URL built from `github.run_id` in the title/body (D5 attribution),
  // and exits 1 if the loop opened zero issues (D6).
  //
  // These are declared as plain (non-template-literal) constants where
  // possible so `${{ ... }}` GitHub Actions expressions do not need escaping;
  // NOTIFY_CANONICAL_STEPS is a template literal (it is multi-line) so every
  // `${{ ... }}` inside it IS escaped as `\${{ ... }}`.
  // -------------------------------------------------------------------------
  const NOTIFY_D2A_IF =
    "if: ${{ !cancelled() && (contains(needs.*.result, 'failure') || contains(needs.*.result, 'skipped')) }}";

  const NOTIFY_CANONICAL_STEPS = `    steps:
      - name: Open issues for failing jobs
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          NEEDS_JSON: \${{ toJSON(needs) }}
          RUN_URL: https://github.com/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
        run: |
          set -euo pipefail
          opened=0
          for job in $(echo "$NEEDS_JSON" | jq -r 'to_entries[] | select(.value.result != "success") | .key'); do
            gh issue create --title "nightly failure: $job" --body "Job $job failed. See $RUN_URL"
            opened=$((opened + 1))
          done
          if [ "$opened" -eq 0 ]; then
            echo "notify fired but enumerated zero failing jobs" >&2
            exit 1
          fi
`;

  const NOTIFY_PERMISSIONS = `    permissions:
      contents: read
      issues: write
`;

  // -------------------------------------------------------------------------
  // TEETH Q: nightlyNotifyCanOpenIssues (ADR-0200 D3)
  // -------------------------------------------------------------------------

  // Q1 — the notify job's OWN permissions: block carries a live issues: write key.
  // Uses the real canonical body/condition (BLOCKER 1/2 fix) so this fixture is
  // never satisfiable ONLY by luck of a non-compliant shape. [ok]
  const qOwnPermissionsGrant = `name: Nightly
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
  notify:
    needs: [mutation]
    ${NOTIFY_D2A_IF}
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}${NOTIFY_CANONICAL_STEPS}`;
  {
    const r = nightlyNotifyCanOpenIssues(qOwnPermissionsGrant);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH Q1: nightlyNotifyCanOpenIssues rejected a notify job whose OWN permissions: block grants issues: write. Reason: ${r.reason}`,
      };
    }
  }

  // Q2 — notify has NO own permissions: block; the TOP-LEVEL workflow permissions
  // grants issues: write. [ok]
  const qTopLevelGrantNoOwnBlock = `name: Nightly
on:
  workflow_dispatch:
permissions:
  contents: read
  issues: write
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
  notify:
    needs: [mutation]
    ${NOTIFY_D2A_IF}
    runs-on: ubuntu-latest
${NOTIFY_CANONICAL_STEPS}`;
  {
    const r = nightlyNotifyCanOpenIssues(qTopLevelGrantNoOwnBlock);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH Q2: nightlyNotifyCanOpenIssues rejected a notify job with NO own permissions: block, relying on the top-level grant — GitHub inherits the workflow-level permissions when a job declares none. Reason: ${r.reason}`,
      };
    }
  }

  // Q3 — only contents: read exists anywhere. [NOT ok]
  const qOnlyContentsRead = `name: Nightly
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
  notify:
    needs: [mutation]
    if: failure()
    runs-on: ubuntu-latest
    steps:
      - run: gh issue create --title x --body y
`;
  {
    const r = nightlyNotifyCanOpenIssues(qOnlyContentsRead);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH Q3: nightlyNotifyCanOpenIssues accepted a workflow where only contents: read exists anywhere — issues: write is nowhere granted',
      };
    }
  }

  // Q4 — the grant appears ONLY inside a # comment. [NOT ok]
  const qGrantOnlyInComment = `name: Nightly
on:
  workflow_dispatch:
permissions:
  contents: read
  # issues: write (left here for reference; do not uncomment without ADR-0200 D3 review)
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
  notify:
    needs: [mutation]
    if: failure()
    runs-on: ubuntu-latest
    steps:
      - run: gh issue create --title x --body y
`;
  {
    const r = nightlyNotifyCanOpenIssues(qGrantOnlyInComment);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH Q4: nightlyNotifyCanOpenIssues accepted a `# issues: write` line that is a ' +
          'COMMENT, not a live YAML key — a commented-out grant is not a grant',
      };
    }
  }

  // Q5 — issues: read (present, but not write). [NOT ok]
  const qIssuesReadOnly = `name: Nightly
on:
  workflow_dispatch:
permissions:
  contents: read
  issues: read
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
  notify:
    needs: [mutation]
    if: failure()
    runs-on: ubuntu-latest
    steps:
      - run: gh issue create --title x --body y
`;
  {
    const r = nightlyNotifyCanOpenIssues(qIssuesReadOnly);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH Q5: nightlyNotifyCanOpenIssues accepted issues: read as if it were issues: write — gh issue create needs write',
      };
    }
  }

  // Q6 — THE GITHUB SEMANTICS TRAP: notify has its OWN permissions: block that
  // LACKS issues:, while the TOP LEVEL grants it. A job-level permissions: block
  // REPLACES the workflow-level one — so this must be [NOT ok] even though a
  // naive "check both blocks, OR them together" impl would accept it.
  const qOwnBlockLacksIssuesTopLevelGrants = `name: Nightly
on:
  workflow_dispatch:
permissions:
  contents: read
  issues: write
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
  notify:
    needs: [mutation]
    if: failure()
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - run: gh issue create --title x --body y
`;
  {
    const r = nightlyNotifyCanOpenIssues(qOwnBlockLacksIssuesTopLevelGrants);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH Q6: nightlyNotifyCanOpenIssues accepted a notify job with its OWN ' +
          'permissions: block (contents: read only) while the TOP LEVEL grants issues: write — ' +
          "a job-level permissions: block REPLACES the workflow-level one in GitHub's real " +
          'semantics, so the top-level grant is dead here; an OR-both-blocks impl misses this',
      };
    }
  }

  // Q7 — positive control: the full canonical shape (all 5 nightly jobs + notify
  // fanning in, own permissions: block granting issues: write). [ok]
  const qPositiveControlCanonical = `name: Nightly
on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
  mutation-server:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-server
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
  smoke-republish:
    runs-on: ubuntu-latest
    steps:
      - run: just smoke-republish
  changelog-freshness:
    runs-on: ubuntu-latest
    steps:
      - run: node scripts/changelog-freshness.mjs --check
  notify:
    needs: [mutation, mutation-server, coverage, smoke-republish, changelog-freshness]
    ${NOTIFY_D2A_IF}
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}${NOTIFY_CANONICAL_STEPS}`;
  {
    const r = nightlyNotifyCanOpenIssues(qPositiveControlCanonical);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH Q7-good: nightlyNotifyCanOpenIssues rejected the full canonical 5-job + notify shape — the gate must be satisfiable by the shape the real nightly.yml will actually ship. Reason: ${r.reason}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // TEETH R: nightlyNotifyIsWired (ADR-0200 D1/D2/D2a/D5/D6)
  // STRENGTHENED CONTRACT (red-team round 1 finding — BLOCKER 1/2): this
  // predicate must gate the ENUMERATION itself, not merely "a gh issue create
  // line exists somewhere". ok: true requires ALL of:
  //   1. the notify job exists and its needs: covers EVERY other job key in
  //      the file (derived from the file, never hardcoded — R2);
  //   2. the job-level if: is the ADR-0200 D2a condition — admits BOTH
  //      failure and skipped, stays quiet on green, ignores cancellation —
  //      not bare failure() (R3b) and not bare always() (R3c), and not
  //      absent (R3);
  //   3. the body references toJSON(needs) (or an equivalent NEEDS_JSON env
  //      var sourced from it) — a single hardcoded gh issue create with no
  //      enumeration REDs even though a create call is present (R10);
  //   4. each opened issue's title/body is attributed to the ENUMERATED job
  //      (the loop variable, or an equivalent per-job token) — a generic,
  //      un-attributed title REDs even with real enumeration (R11);
  //   5. the body references the run (an id or URL derived from
  //      github.run_id) — no run link REDs even with per-job attribution (R12);
  //   6. the body has a zero-enumerated exit 1 guard (D6) — enumeration
  //      without it REDs (R13);
  //   7. the gh issue create invocation is REAL code, not text living only
  //      inside a `#` comment line (R14, R4);
  //   8. it is not softened — no `|| true`, no `set +e`, no truthy
  //      continue-on-error (R5, R6, R7).
  // A shared 3-sibling-job base (mutation, mutation-server, coverage) is enough
  // to prove the "needs: covers every OTHER job key" derivation; the real file
  // has 5 siblings, which Check 21 exercises directly. NOTIFY_D2A_IF and
  // NOTIFY_CANONICAL_STEPS (declared above, ahead of TEETH Q) are the single
  // source of the compliant shape — every [ok] fixture below uses them
  // unmodified, and every [NOT ok] fixture differs from them by exactly one
  // named property.
  // -------------------------------------------------------------------------

  const R_SIBLING_JOBS = `  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
  mutation-server:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-server
  coverage:
    runs-on: ubuntu-latest
    steps:
      - run: just coverage
`;

  // R1 — no notify job at all. [NOT ok]
  const rNoNotifyJob = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}`;
  {
    const r = nightlyNotifyIsWired(rNoNotifyJob);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: 'TEETH R1: nightlyNotifyIsWired accepted a workflow with no notify: job at all',
      };
    }
  }

  // R2 — needs: omits one job key that is present in the file (coverage), body
  // and if: otherwise canonical. Kills: an impl that hardcodes the required set
  // instead of deriving it from the file. [NOT ok]
  const rNeedsOmitsJob = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs: [mutation, mutation-server]
    ${NOTIFY_D2A_IF}
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}${NOTIFY_CANONICAL_STEPS}`;
  {
    const r = nightlyNotifyIsWired(rNeedsOmitsJob);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R2: nightlyNotifyIsWired accepted a notify job whose needs: omits the ' +
          'coverage job (present elsewhere in the file) — a future unwired job must RED ' +
          'automatically, so the required set must be DERIVED, never hardcoded',
      };
    }
  }

  // R3 — notify job has no job-level if: at all, everything else canonical. [NOT ok]
  const rNoIfKey = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs: [mutation, mutation-server, coverage]
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}${NOTIFY_CANONICAL_STEPS}`;
  {
    const r = nightlyNotifyIsWired(rNoIfKey);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R3: nightlyNotifyIsWired accepted a notify job with no job-level if: at all — without a condition the job only runs on the (never-happens) all-succeeded path',
      };
    }
  }

  // R3b — job-level `if: failure()` ALONE (the OLD, now-wrong canonical form),
  // everything else canonical (ADR-0200 D2a). Kills: an impl that accepts any
  // non-empty if: line without checking it admits `skipped` — a job neutered
  // into `skipped` would leave notify silently skipped too, reproducing the
  // original "red and silent" bug one level up. [NOT ok]
  const rIfFailureAlone = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs: [mutation, mutation-server, coverage]
    if: failure()
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}${NOTIFY_CANONICAL_STEPS}`;
  {
    const r = nightlyNotifyIsWired(rIfFailureAlone);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R3b: nightlyNotifyIsWired accepted job-level if: failure() ALONE — per ADR-0200 ' +
          'D2a this does not admit a `skipped` job (exactly what a successful job-level neuter ' +
          'looks like at runtime), so it must RED; only the D2a condition is admitted',
      };
    }
  }

  // R3c — job-level `if: always()` ALONE. Kills: an impl that accepts any
  // "obviously always-run" condition — always() fires on a fully green night
  // too, which would make D6's zero-enumerated exit 1 guard red EVERY green
  // night (the guard is meant to fire only when the condition fired and found
  // nothing, not every single night). [NOT ok]
  const rIfAlwaysAlone = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs: [mutation, mutation-server, coverage]
    if: always()
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}${NOTIFY_CANONICAL_STEPS}`;
  {
    const r = nightlyNotifyIsWired(rIfAlwaysAlone);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R3c: nightlyNotifyIsWired accepted job-level if: always() ALONE — this fires on ' +
          "a fully green night and would make D6's zero-guard red every green night; only the " +
          'D2a condition (quiet on green, admits failure OR skipped, ignores cancellation) is admitted',
      };
    }
  }

  // R4 — no `gh issue create` invocation anywhere in the body. [NOT ok]
  const rNoGhIssueCreate = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs: [mutation, mutation-server, coverage]
    ${NOTIFY_D2A_IF}
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}    steps:
      - name: Notify
        env:
          NEEDS_JSON: \${{ toJSON(needs) }}
        run: echo "something failed, please look at $NEEDS_JSON"
`;
  {
    const r = nightlyNotifyIsWired(rNoGhIssueCreate);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R4: nightlyNotifyIsWired accepted a notify job whose body never calls gh issue create',
      };
    }
  }

  // R5 — the create call is followed by `|| true`, silently swallowing failure. [NOT ok]
  const rCreateThenOrTrue = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs: [mutation, mutation-server, coverage]
    ${NOTIFY_D2A_IF}
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}    steps:
      - name: Open issues for failing jobs
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          NEEDS_JSON: \${{ toJSON(needs) }}
          RUN_URL: https://github.com/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
        run: |
          set -euo pipefail
          opened=0
          for job in $(echo "$NEEDS_JSON" | jq -r 'to_entries[] | select(.value.result != "success") | .key'); do
            gh issue create --title "nightly failure: $job" --body "Job $job failed. See $RUN_URL" || true
            opened=$((opened + 1))
          done
          if [ "$opened" -eq 0 ]; then
            echo "notify fired but enumerated zero failing jobs" >&2
            exit 1
          fi
`;
  {
    const r = nightlyNotifyIsWired(rCreateThenOrTrue);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R5: nightlyNotifyIsWired accepted a notify job whose gh issue create is softened with `|| true`',
      };
    }
  }

  // R6 — `set +e` in the body (defeats set -euo pipefail's protection),
  // otherwise fully canonical enumeration. [NOT ok]
  const rSetPlusE = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs: [mutation, mutation-server, coverage]
    ${NOTIFY_D2A_IF}
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}    steps:
      - name: Open issues for failing jobs
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          NEEDS_JSON: \${{ toJSON(needs) }}
          RUN_URL: https://github.com/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
        run: |
          set -euo pipefail
          set +e
          opened=0
          for job in $(echo "$NEEDS_JSON" | jq -r 'to_entries[] | select(.value.result != "success") | .key'); do
            gh issue create --title "nightly failure: $job" --body "Job $job failed. See $RUN_URL"
            opened=$((opened + 1))
          done
          if [ "$opened" -eq 0 ]; then
            echo "notify fired but enumerated zero failing jobs" >&2
            exit 1
          fi
`;
  {
    const r = nightlyNotifyIsWired(rSetPlusE);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R6: nightlyNotifyIsWired accepted a notify job whose body disables error handling with `set +e`',
      };
    }
  }

  // R7 — truthy continue-on-error on the notify job itself, body otherwise
  // fully canonical. [NOT ok]
  const rTruthyCoe = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs: [mutation, mutation-server, coverage]
    ${NOTIFY_D2A_IF}
    continue-on-error: true
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}${NOTIFY_CANONICAL_STEPS}`;
  {
    const r = nightlyNotifyIsWired(rTruthyCoe);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R7: nightlyNotifyIsWired accepted a notify job with job-level continue-on-error: true — a soft-failing notifier is a silently broken one',
      };
    }
  }

  // R10 — a SINGLE hardcoded `gh issue create`, with NO toJSON(needs) (or any
  // NEEDS_JSON-equivalent) anywhere in the job. This is the exact non-compliant
  // shape a red-team implementation shipped as its "notify job" — a create call
  // is present, but there is no enumeration behind it, so it opens exactly one
  // generic issue no matter how many jobs actually failed (violates D2/D5). [NOT ok]
  const rHardcodedNoEnumeration = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs: [mutation, mutation-server, coverage]
    ${NOTIFY_D2A_IF}
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}    steps:
      - name: Open issue
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          gh issue create --title "nightly failure" --body "see the run"
`;
  {
    const r = nightlyNotifyIsWired(rHardcodedNoEnumeration);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R10: nightlyNotifyIsWired accepted a notify job with a SINGLE hardcoded gh issue ' +
          'create and no toJSON(needs) enumeration anywhere — this opens exactly one generic issue ' +
          'no matter how many jobs failed, violating D2/D5; "a create call exists" is not enough',
      };
    }
  }

  // R11 — enumerates via toJSON(needs)/jq/a real loop, but the issue title/body
  // never reference the loop variable or any per-job token — every opened issue
  // is generically titled "nightly failure" regardless of which job it is for.
  // Kills: an impl that only checks "gh issue create appears inside a for loop"
  // without checking the create call is actually attributed to the enumerated
  // job (EARS: "naming the failing job"). [NOT ok]
  const rEnumeratesNoAttribution = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs: [mutation, mutation-server, coverage]
    ${NOTIFY_D2A_IF}
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}    steps:
      - name: Open issues for failing jobs
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          NEEDS_JSON: \${{ toJSON(needs) }}
          RUN_URL: https://github.com/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
        run: |
          set -euo pipefail
          opened=0
          for job in $(echo "$NEEDS_JSON" | jq -r 'to_entries[] | select(.value.result != "success") | .key'); do
            gh issue create --title "nightly failure" --body "See $RUN_URL"
            opened=$((opened + 1))
          done
          if [ "$opened" -eq 0 ]; then
            echo "notify fired but enumerated zero failing jobs" >&2
            exit 1
          fi
`;
  {
    const r = nightlyNotifyIsWired(rEnumeratesNoAttribution);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R11: nightlyNotifyIsWired accepted a notify job that enumerates the failing set ' +
          'in a real loop but never references the loop variable ($job) or any per-job token in ' +
          'the issue title/body — every issue is generically titled, which fails EARS attribution',
      };
    }
  }

  // R12 — enumerates with real per-job attribution, but NEVER references the
  // run (no run id, no run URL, no github.run_id anywhere). Kills: an impl
  // that checks "per-job title present" without also requiring the run to be
  // linked (EARS: "linking the run"). [NOT ok]
  const rNoRunLink = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs: [mutation, mutation-server, coverage]
    ${NOTIFY_D2A_IF}
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}    steps:
      - name: Open issues for failing jobs
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          NEEDS_JSON: \${{ toJSON(needs) }}
        run: |
          set -euo pipefail
          opened=0
          for job in $(echo "$NEEDS_JSON" | jq -r 'to_entries[] | select(.value.result != "success") | .key'); do
            gh issue create --title "nightly failure: $job" --body "Job $job failed"
            opened=$((opened + 1))
          done
          if [ "$opened" -eq 0 ]; then
            echo "notify fired but enumerated zero failing jobs" >&2
            exit 1
          fi
`;
  {
    const r = nightlyNotifyIsWired(rNoRunLink);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R12: nightlyNotifyIsWired accepted a notify job with real per-job attribution ' +
          'but NO run id / run URL reference anywhere in the body — EARS requires the opened ' +
          'issue to also LINK THE RUN, not just name the job',
      };
    }
  }

  // R13 — enumerates with real per-job attribution and a run link, but has NO
  // zero-enumerated exit 1 guard (D6). Kills: an impl that stops checking once
  // it has seen a compliant-looking loop, without requiring the trailing guard
  // that makes "the condition fired and found nothing" loud instead of silent. [NOT ok]
  const rNoZeroGuard = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs: [mutation, mutation-server, coverage]
    ${NOTIFY_D2A_IF}
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}    steps:
      - name: Open issues for failing jobs
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          NEEDS_JSON: \${{ toJSON(needs) }}
          RUN_URL: https://github.com/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
        run: |
          set -euo pipefail
          for job in $(echo "$NEEDS_JSON" | jq -r 'to_entries[] | select(.value.result != "success") | .key'); do
            gh issue create --title "nightly failure: $job" --body "Job $job failed. See $RUN_URL"
          done
`;
  {
    const r = nightlyNotifyIsWired(rNoZeroGuard);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R13: nightlyNotifyIsWired accepted a notify job with a real enumeration loop but ' +
          'NO zero-enumerated exit 1 guard (ADR-0200 D6) — a run that fires and quietly opens ' +
          'nothing must be loud, not indistinguishable from a green night',
      };
    }
  }

  // R14 — the ONLY `gh issue create` text in the whole job is inside a `#`
  // comment line; the actual run: step does something else entirely. Kills: an
  // impl that greps for the substring "gh issue create" anywhere in the block
  // text instead of checking it is live, executable code. [NOT ok]
  const rCreateOnlyInComment = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs: [mutation, mutation-server, coverage]
    ${NOTIFY_D2A_IF}
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}    steps:
      - name: Open issues for failing jobs
        env:
          NEEDS_JSON: \${{ toJSON(needs) }}
        run: |
          set -euo pipefail
          # gh issue create --title "nightly failure" --body "see the run"
          echo "TODO: wire this up for real"
`;
  {
    const r = nightlyNotifyIsWired(rCreateOnlyInComment);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH R14: nightlyNotifyIsWired accepted a notify job whose ONLY gh issue create text ' +
          'lives inside a # comment line — the real run: step just echoes a TODO',
      };
    }
  }

  // R8 — canonical, needs: as a BLOCK sequence, D2a condition, full compliant
  // enumeration (toJSON(needs), per-job attribution, run link, zero-guard). [ok]
  const rGoodBlock = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs:
      - mutation
      - mutation-server
      - coverage
    ${NOTIFY_D2A_IF}
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}${NOTIFY_CANONICAL_STEPS}`;
  {
    const r = nightlyNotifyIsWired(rGoodBlock);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH R8: nightlyNotifyIsWired rejected a correctly wired, fully compliant notify job using the BLOCK-sequence needs: form. Reason: ${r.reason}`,
      };
    }
  }

  // R9 — canonical, needs: as a FLOW sequence, same compliant shape as R8. [ok]
  const rGoodFlow = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs: [mutation, mutation-server, coverage]
    ${NOTIFY_D2A_IF}
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}${NOTIFY_CANONICAL_STEPS}`;
  {
    const r = nightlyNotifyIsWired(rGoodFlow);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH R9: nightlyNotifyIsWired rejected a correctly wired, fully compliant notify job using the FLOW needs: [a, b, c] form. Reason: ${r.reason}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // TEETH S: noOtherJobHoldsIssuesWrite (ADR-0200 D3 — least-privilege negative space)
  // -------------------------------------------------------------------------

  // S1 — issues: write at the TOP LEVEL. [NOT ok]
  const sTopLevelGrant = `name: Nightly
on:
  workflow_dispatch:
permissions:
  contents: read
  issues: write
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
  notify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
    steps:
      - run: gh issue create --title x --body y
`;
  {
    const r = noOtherJobHoldsIssuesWrite(sTopLevelGrant);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH S1: noOtherJobHoldsIssuesWrite accepted issues: write at the TOP-LEVEL permissions: block — ADR-0200 D3 requires the grant to be job-scoped only',
      };
    }
  }

  // S2 — issues: write on the `mutation` job. [NOT ok]
  const sMutationJobGrant = `name: Nightly
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  mutation:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
    steps:
      - run: just mutate-core
  notify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
    steps:
      - run: gh issue create --title x --body y
`;
  {
    const r = noOtherJobHoldsIssuesWrite(sMutationJobGrant);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH S2: noOtherJobHoldsIssuesWrite accepted issues: write on the mutation job — a ' +
          'job that shells third-party build scripts under cargo-mutants must never hold issue-write',
      };
    }
  }

  // S3 — issues: write ONLY on notify. [ok]
  const sOnlyNotifyGrant = `name: Nightly
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
  notify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
    steps:
      - run: gh issue create --title x --body y
`;
  {
    const r = noOtherJobHoldsIssuesWrite(sOnlyNotifyGrant);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH S3: noOtherJobHoldsIssuesWrite rejected a workflow where issues: write is held ONLY by notify — the least-privilege gate must be satisfiable. Reason: ${r.reason}`,
      };
    }
  }

  // S4 — MAJOR (red-team round 1): a whole-file "count `issues: write`
  // occurrences" cheat is passable by S1-S3 alone if it merely checks the
  // total count is not "too many", because S1/S2 both put the SECOND grant
  // after notify's own (textually last) and a "does the LAST occurrence sit
  // in notify's block" cheat also reads clean. This fixture reverses the
  // order — `notify` is declared FIRST, `mutation` SECOND — so notify's valid
  // own grant is the FIRST occurrence in the file and mutation's illegitimate
  // grant is the LAST. A cheat that only inspects the first (or only counts
  // total occurrences without attributing each one to its own job) reads this
  // as clean; only a predicate that attributes EVERY occurrence to its
  // enclosing job, independently, will RED it. [NOT ok]
  const sNotifyFirstMutationSecondBothGrant = `name: Nightly
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  notify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
    steps:
      - run: gh issue create --title x --body y
  mutation:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
    steps:
      - run: just mutate-core
`;
  {
    const r = noOtherJobHoldsIssuesWrite(sNotifyFirstMutationSecondBothGrant);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH S4: noOtherJobHoldsIssuesWrite accepted a workflow where notify (declared FIRST, ' +
          'with a valid own grant) is followed by mutation (declared SECOND, ALSO holding its own ' +
          'issues: write) — a first-occurrence-only or total-count cheat reads this as clean; the ' +
          'predicate must attribute EVERY issues: write occurrence to its own enclosing job',
      };
    }
  }

  // -------------------------------------------------------------------------
  // TEETH T: notifyArtifactNamesAreDistinct (ADR-0200 D7)
  // -------------------------------------------------------------------------

  // T1 — identical artifact name: in both mutation jobs. [NOT ok]
  const tIdenticalNames = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload mutants.out on failure
        if: always()
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out
          path: mutants.out/
  mutation-server:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-server
      - name: Upload mutants.out on failure
        if: always()
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out
          path: mutants.out/
`;
  {
    const r = notifyArtifactNamesAreDistinct(tIdenticalNames);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T1: notifyArtifactNamesAreDistinct accepted identical artifact name: values ' +
          '("mutants-out") in the mutation and mutation-server jobs — upload-artifact v4 ' +
          'hard-errors on a duplicate name within one run',
      };
    }
  }

  // T2 — distinct artifact names. [ok]
  const tDistinctNames = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload mutants.out on failure
        if: always()
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-core
          path: mutants.out/
  mutation-server:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-server
      - name: Upload mutants.out on failure
        if: always()
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-server
          path: mutants.out/
`;
  {
    const r = notifyArtifactNamesAreDistinct(tDistinctNames);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH T2: notifyArtifactNamesAreDistinct rejected distinct artifact names (mutants-out-core / mutants-out-server). Reason: ${r.reason}`,
      };
    }
  }

  // T3 — MINOR (red-team round 1): the mutation job's upload step has NO name:
  // key at all (upload-artifact v4 actually requires one; an absent name: is
  // itself invalid). Kills: an impl that reads a missing name: as `undefined`
  // and compares it to mutation-server's real name with `!==`, which is true
  // (undefined !== 'mutants-out-server'), so a naive inequality check would
  // wrongly call this "distinct" — a missing name must not silently compare as
  // different-therefore-fine. [NOT ok]
  const tMissingNameKey = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload mutants.out on failure
        if: always()
        uses: ${UPLOAD_USES}
        with:
          path: mutants.out/
  mutation-server:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-server
      - name: Upload mutants.out on failure
        if: always()
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-server
          path: mutants.out/
`;
  {
    const r = notifyArtifactNamesAreDistinct(tMissingNameKey);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH T3: notifyArtifactNamesAreDistinct accepted a mutation job whose upload step has ' +
          "NO name: key at all — a missing name must not compare as 'distinct' from the sibling " +
          "job's real name; upload-artifact v4 requires a name: on every step",
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
  // .github/workflows/nightly.yml:85-90). Three SEPARATE checks, each passing its
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

  // =========================================================================
  // lp-03 REAL FILE CHECKS (ADR-0200 — nightly failure notification)
  //   Check 18 → EXPECTED RED (no upload-artifact step in the mutation job yet)
  //   Checks 19–23 are not reached today (this eval returns on first failure at
  //   Check 18) but are all independently RED on the committed tree except
  //   Check 23, which would pass in isolation (see the file-header note above).
  // =========================================================================

  // Check 18: the mutation job uploads mutants.out/ on failure (EXPECTED RED).
  // GREEN edit: add an actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
  // step to the mutation job with if: always(), a non-empty name:, and path: mutants.out/.
  {
    const r = mutationJobUploadsMutantsOutOnFailure(nightlyYml, 'mutation');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `nightly.yml 'mutation' job does not upload mutants.out/ on failure (EXPECTED RED): ${r.reason}`,
      };
    }
  }

  // Check 19: the mutation-server job uploads mutants.out/ on failure (EXPECTED
  // RED). Job name is spelled out explicitly (not looped with Check 18) so a fix
  // to only one of the two jobs cannot leave the other unpinned.
  // GREEN edit: same upload-artifact step, added to mutation-server.
  {
    const r = mutationJobUploadsMutantsOutOnFailure(nightlyYml, 'mutation-server');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `nightly.yml 'mutation-server' job does not upload mutants.out/ on failure (EXPECTED RED): ${r.reason}`,
      };
    }
  }

  // Check 20: the mutation and mutation-server upload-artifact `name:` values are
  // distinct (EXPECTED RED — no upload steps exist yet).
  // GREEN edit: give the two upload steps distinct name: values (v4 hard-errors
  // on a duplicate artifact name within one workflow run).
  {
    const r = notifyArtifactNamesAreDistinct(nightlyYml);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `nightly.yml mutation/mutation-server upload-artifact name: values are not distinct (EXPECTED RED): ${r.reason}`,
      };
    }
  }

  // Check 21: the notify job is wired — exists, needs: covers every other job,
  // has a job-level if:, calls gh issue create, and is not softened (EXPECTED
  // RED — no notify: job exists yet).
  // GREEN edit: add the notify job per ADR-0200 D1/D2/D5/D6.
  {
    const r = nightlyNotifyIsWired(nightlyYml);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `nightly.yml notify job is not correctly wired (EXPECTED RED): ${r.reason}`,
      };
    }
  }

  // Check 22: the notify job can effectively open issues — its own permissions:
  // block (or, absent one, the top-level block) grants issues: write (EXPECTED
  // RED — top-level permissions: is contents: read only and there is no notify job).
  // GREEN edit: give the notify job its own `permissions: { contents: read, issues: write }`
  // per ADR-0200 D3.
  {
    const r = nightlyNotifyCanOpenIssues(nightlyYml);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `nightly.yml notify job cannot effectively open issues (EXPECTED RED): ${r.reason}`,
      };
    }
  }

  // Check 23: no job other than notify (and not the top-level block) holds
  // issues: write (least-privilege negative space, ADR-0200 D3). This check
  // would PASS in isolation on the committed tree today (no job holds
  // issues: write yet), but is never reached — Check 18 REDs first.
  {
    const r = noOtherJobHoldsIssuesWrite(nightlyYml);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `nightly.yml grants issues: write outside the notify job: ${r.reason}`,
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
