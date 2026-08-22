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
//     (at the time these three checks were written, decision-hook
//     mdrewt/claude-harness#14 — notification channel — was still open, so the
//     reversible default was a documented policy and NOT a notification Action.
//     lp-03 EXERCISED that recorded reversibility: ADR-0200 adds a `notify` job that
//     opens one GitHub issue per non-success job. The policy comments remain
//     required — they are the human triage ROUTING the issue body cannot carry —
//     but they are no longer the only failure channel.)
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
//
// EXPECTED REAL-TREE STATE AT RED (lp-03 ROUND 3 additions — three independent
// review lenses [red-team on the SHIPPED implementation, a code reviewer, and a
// GitHub-Actions-semantics auditor] found one BLOCKER-class bypass, two MAJOR
// gate holes, and two false-RED risks; TEETH U continues the lettering after
// TEETH T, and none of TEETH A-T are touched):
//   jobIsNotNeutered exists and is GREEN on the committed tree, but it has NOT
//   yet been extended with (U1) "a guarded job may contain AT MOST ONE run:
//   step" or (U2) "no env: mapping inside a guarded job may declare a PATH
//   key" — red-team demonstrated a full-eval-stays-GREEN bypass on both axes: a
//   step that writes a `just` shim onto $GITHUB_PATH before the real recipe
//   step, or an equivalent env: PATH: override, either of which shadows the
//   real `just mutate-core`/`mutate-server` invocation while every EXISTING
//   predicate (exact run-step text, no if:, no continue-on-error) reads clean.
//   mutationJobUploadsMutantsOutOnFailure has NOT yet been extended to parse a
//   flow-style `with: { key: value, ... }` mapping (U5) — nightly.yml already
//   uses this style for several actions (house style), and today the predicate
//   silently fails to read `path:`/`name:` out of a flow mapping at all, which
//   is a FALSE RED on a legitimately-styled upload step, not merely a missing
//   feature.
//   nightlyNotifyIsWired's D2a condition clause (U3) still matches the
//   condition VALUE as raw text including any trailing `#` comment (a
//   comment-laundering bypass: `if: true # ...failure...skipped...` reads as
//   compliant today though the runtime condition is the bare `true`), and still
//   admits a bare two-term failure-or-skipped condition with no third
//   `cancelled` term (a job that times out concludes `cancelled`, which
//   satisfies neither term). nightlyNotifyIsWired also has no dedicated upper
//   bound (U4) on `gh issue create` invocations per enumerated job — only a
//   `createLines.length === 0` lower-bound check exists today.
//   topLevelPermissions (used by nightlyNotifyCanOpenIssues) still requires an
//   EXACT `lines[i] !== 'permissions:'` line match (U6) — a trailing comment on
//   that mapping key (`permissions: # least privilege — see ADR-0200`, legal
//   YAML) makes the top-level grant invisible to it, a false RED.
//   Consequence: the eval now REDs at TEETH U1a — the literal red-team
//   $GITHUB_PATH-shim fixture, the first round-3 fixture in file order. TEETH
//   U1b/U1c, U2a-c, U3a-c, U4a, U5a-b, U6a are not reached this run; each
//   surfaces in turn as the specialist closes the corresponding rule, exactly
//   as TEETH O1 gated the round-1 D8 carve-out. All of TEETH A-T and Checks
//   1-23 were GREEN on the committed tree immediately before this round's teeth
//   were added, and remain untouched by this round.
//   Once the predicates land, TEETH U1c/U2c/U5a/U6a (the positive controls /
//   false-RED guards) and every pre-existing positive control that composes
//   NOTIFY_D2A_IF (now three-term) must ALSO stay GREEN — the round updates one
//   shared constant rather than hand-editing each of the dozen fixtures that
//   reference it.
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
//
// ===========================================================================
// 16r-c (ADR-0196 changelog-freshness gate: neuter-freedom + the git-cliff pin)
// ===========================================================================
// The `changelog-freshness` job shipped in 13r-g is the FIFTH nightly gate and
// the only one no wiring check has ever looked at: it appears in no predicate
// in this file, so today it can be deleted, `if: false`d, softened with
// continue-on-error, or hollowed out step-by-step and this eval stays green.
// TEETH V + TEETH W and Checks 24-29 close that, and generalise two rules the
// other four gates already enjoy.
//
// WHAT IS NEW (the contract the specialist implements):
//   - jobIsNotNeutered(yaml, jobName, opts = {}) grows an ADDITIVE third
//     parameter. `opts.gates` is an ORDERED array of DATA descriptors — never
//     functions; a callback gate would be a predicate the fixtures could not
//     pin — defaulting to [{ kind: 'just' }], which MUST be byte-equivalent to
//     today's behaviour (tooth V15). `{ kind: 'script', text }` demands the
//     step's normalised live run text EQUAL `text`; an unrecognised kind FAILS
//     CLOSED (V16). gates[k] must match the k-th `run:` step IN ORDER, and run
//     steps after the last gate stay legal — tooth O13 depends on that, and
//     V13 re-pins it for this job. A gate step may not carry a `shell:` own key
//     other than the literal `bash`: `shell: 'true {0}'` makes GitHub run
//     `true <script>`, so the step exits 0 having executed nothing while an
//     exact run-text match reads perfectly clean (V14 / V14b).
//   - CHANGELOG_FRESHNESS_GATES pins the job's TWO gate steps VERBATIM (the TAP
//     gating-suite body, then `node scripts/changelog-freshness.mjs --check`).
//     This is the MUTATE_SERVER_CAP_BASELINE precedent applied to text: a
//     needle list ("mentions node --test", "mentions --check") is satisfied by
//     a single `echo` that merely NAMES the real command — the red-team's
//     proven BLOCKER, pinned as tooth V12. Every V fixture is RENDERED FROM the
//     constant, so V1 is a ROUND TRIP: a pin that would false-RED the committed
//     tree cannot pass V1 either.
//   - nightlyDeclaresJob / nightlyJobStructureIsUnambiguous /
//     nightlyHasNoWorkflowScopeNeuters cover the neuters that live OUTSIDE any
//     job block and are therefore invisible to every job-scoped scanner in this
//     file: deleting the job key; declaring it TWICE (last-wins in a real YAML
//     parser, FIRST-wins in this file's text scanners, so a second `if: false`
//     copy reads green today); a top-level `defaults: run: shell:` that no-ops
//     EVERY run step in EVERY job; and a top-level `env: PATH:` that shims the
//     toolchain for all five gates at once.
//   - GIT_CLIFF_PINNED_VERSION / CHANGELOG_RECIPE_BODY / gitCliffPinsAgree
//     couple the justfile `changelog:` recipe to the workflow's
//     `git-cliff@<version>` install pin. Both sides generate the SAME
//     CHANGELOG.md the freshness checker diffs against; when they drift, an
//     upstream rendering change flips every entry to missing+extra at once and
//     REDs the gate for a reason that has nothing to do with freshness.
//
// EXPECTED REAL-TREE STATE AT RED (16r-c):
//   None of CHANGELOG_FRESHNESS_GATES, nightlyDeclaresJob,
//   nightlyJobStructureIsUnambiguous, nightlyHasNoWorkflowScopeNeuters,
//   GIT_CLIFF_PINNED_VERSION, CHANGELOG_RECIPE_BODY or gitCliffPinsAgree exists
//   in this file yet, and jobIsNotNeutered still takes two parameters.
//   Consequence: the eval THROWS at TEETH V0 — the fixture-integrity backstop,
//   the first line of the new section — with `ReferenceError:
//   CHANGELOG_FRESHNESS_GATES is not defined`. evals/run.mjs wraps each eval in
//   its own try/catch and records a thrower as a synthetic pass:false, so that
//   IS the RED, not a crashed harness. TEETH V1 onward and TEETH W surface in
//   turn as the specialist lands each constant/predicate, exactly as TEETH O1
//   gated the round-1 D8 carve-out and TEETH U1a gated round 3.
//   Of the six new real-file checks, 24-28 are GREEN on the committed tree the
//   moment the predicates exist — they are regression ratchets on wiring that
//   is already correct. Check 29 gitCliffPinsAgree is the sole
//   genuinely-EXPECTED-RED: the justfile declares no GIT_CLIFF_VERSION at all
//   today and its `changelog:` recipe is the single unguarded line
//   `git cliff -o CHANGELOG.md`.
//   All of TEETH A-U and Checks 1-23 are untouched by this slice.
//
// DEFERRED RESIDUALS (proved live by the red-team, deliberately NOT closed
// here). Each is PRE-EXISTING and affects ALL FIVE guarded jobs equally, so
// closing them for changelog-freshness alone would be theatre:
//   - a `uses:` step running arbitrary shell BEFORE the gates: an
//     actions/github-script step carrying a `with: script:` payload, or a local
//     `./.github/actions/…` composite. The positional rule counts `run:` steps
//     only, so neither is seen.
//   - `env: NODE_OPTIONS: --require …` on a gate step — the env scan is a PATH
//     DENYLIST, not an allowlist, so every other injection key walks through.
//   - a job-level `strategy: matrix:` that resolves to ZERO instances (the job
//     concludes success having run nothing).
//   - a job-level `needs:` that makes the job SKIP when a sibling reds.
//   - step- or job-level `working-directory:` (relocates the whole gate).
//   Closing them needs a step-key / uses / env ALLOWLIST applied across all
//   guarded jobs, not one more denylist entry — its own slice. Until then,
//   `notify`'s `skipped` term is the PARTIAL RUNTIME backstop for the
//   matrix/needs pair: a job that concludes `skipped` still opens an issue.
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

// (The old `isTruthyCoeNightly` truthy-BLACKLIST helper was deleted in lp-03: per
// ADR-0200 D8 `continue-on-error:` is now an ALLOWLIST — only the literal `false`
// passes — because the blacklist admitted `${{ github.event_name == 'schedule' }}`,
// a neuter calibrated to read false under the workflow_dispatch a drill uses and
// true on every real cron night.)

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

// ---------------------------------------------------------------------------
// ADR-0200 D8 SUPPORT LAYER: strict block extraction + an anchored, step-aware
// YAML line scanner. Everything below is deliberately String/literal-regex only
// — NO `new RegExp(` (Semgrep detect-non-literal-regexp, remote-only, has bitten
// this project 3×).
// ---------------------------------------------------------------------------

// Indentation (count of leading spaces) of a raw line.
function indentOfLine(line) {
  return line.length - line.trimStart().length;
}

// STRICT job-block extraction (ADR-0200 D8, "own block extraction").
// Same shape as the imported `extractJobBlock`, with ONE difference that is the
// whole point: the shared helper terminates at ANY line at indent 2, which a
// 2-space `  # decoy` comment satisfies — so a neutered step parked BELOW such a
// comment fell outside the scanned block entirely and the gate read clean
// (tooth O17). This variant terminates only at a non-blank, NON-comment line at
// indent <= 2.
//
// `extractJobBlock` itself is deliberately NOT modified or re-exported: it has
// ten callers across four evals and lives outside this slice's `touches:` set.
export function strictJobBlock(yaml, jobName) {
  const lines = yaml.split('\n');
  const keyLine = `  ${jobName}:`;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    // Anchored, exact key match — `  mutation:` must never match `  mutation-server:`.
    if (lines[i] === keyLine || lines[i].startsWith(`${keyLine} `)) {
      start = i;
      break;
    }
  }
  if (start === -1) return '';
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // Blank lines belong to the block (they sit between steps).
    if (line.trim() === '') {
      block.push(line);
      continue;
    }
    // The ONLY terminator: a real, non-comment line at job-key indent or shallower.
    if (indentOfLine(line) <= 2 && !line.trim().startsWith('#')) break;
    block.push(line);
  }
  return `${block.join('\n')}\n`;
}

// ANCHORED key parsing (ADR-0200 D8, "anchored key matching"). `trim().startsWith('if:')`
// never sees `"if": false`, `'if': false` or `if : false` — all three are valid YAML and
// all three neuter a job. Returns { key, value } or null when the line is not a mapping
// entry at all. `text` must already be trimmed and have any leading `- ` removed.
function parseYamlKeyLine(text) {
  let rest = text;
  let key = null;
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const quote = rest[0];
    const end = rest.indexOf(quote, 1);
    if (end === -1) return null;
    key = rest.slice(1, end);
    rest = rest.slice(end + 1);
  } else {
    const colon = rest.indexOf(':');
    if (colon === -1) return null;
    // trimEnd() is what tolerates `if : false` (space BEFORE the colon).
    key = rest.slice(0, colon).trimEnd();
    rest = rest.slice(colon);
  }
  rest = rest.trimStart();
  if (!rest.startsWith(':')) return null;
  return { key, value: rest.slice(1).trim() };
}

// FAIL CLOSED on YAML indirection (ADR-0200 D8). A merge key (`<<: *defaults`) or a bare
// alias (`- *shared_checkout`) can inject an `if:`/`continue-on-error:` this text scanner
// cannot resolve; returning a confident ok:true over text we cannot read is exactly the
// false-green this gate exists to prevent.
function isYamlIndirection(trimmed) {
  let text = trimmed;
  if (text === '-') return false;
  if (text.startsWith('- ')) text = text.slice(2).trim();
  if (text.startsWith('<<:')) return true;
  if (text.startsWith('*')) return true;
  const kv = parseYamlKeyLine(text);
  if (kv === null) return false;
  return kv.value.startsWith('*');
}

// Block-scalar indicators: `|`, `>`, and their chomping/indentation variants
// (`|-`, `|+`, `>-`, `>+`, `|2`, …). A block scalar's BODY is DATA, so a body line
// reading `if: false` must not be mistaken for a key (tooth O13), and a body line
// reading `uses: actions/upload-artifact@…` must not turn a run step into an
// upload step (tooth O12).
function isBlockScalarValue(value) {
  return /^[|>][-+]?[0-9]*$/.test(value);
}

// `uses:` value normalisation: strip the inline `#` comment FIRST (otherwise the
// ` # v4` tag rides along), THEN drop the `@<ref>` tail. Callers compare the result
// with EXACT equality — `indexOf`/`endsWith` would admit `evil/upload-artifact`
// (tooth O10) and `actions/upload-artifact-fake` (tooth O11).
function normaliseUsesValue(value) {
  const hash = value.indexOf('#');
  const noComment = (hash === -1 ? value : value.slice(0, hash)).trim();
  const at = noComment.indexOf('@');
  return (at === -1 ? noComment : noComment.slice(0, at)).trim();
}

// Strip a YAML inline `#` comment from an already-trimmed scalar VALUE. YAML starts a
// comment at a `#` that is preceded by whitespace (or opens the scalar), so
// `true # …failure…skipped…` is the runtime value `true` — the whole point of tooth
// U3a's comment-laundering bypass: matching `failure`/`skipped` against the RAW line
// text launders ANY condition through its own trailing comment.
function stripInlineYamlComment(value) {
  if (value.startsWith('#')) return '';
  const spaceHash = value.indexOf(' #');
  const tabHash = value.indexOf('\t#');
  let cut = spaceHash;
  if (cut === -1 || (tabHash !== -1 && tabHash < cut)) cut = tabHash;
  return (cut === -1 ? value : value.slice(0, cut)).trim();
}

// Drop one layer of surrounding quotes from a flow-mapping value.
function unquoteScalar(value) {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value[value.length - 1] === first) {
      return value.slice(1, value.length - 1);
    }
  }
  return value;
}

// Parse a FLOW-style mapping value (`{ k: v, k2: v2 }`) into [key, value] pairs, or
// null when the shape is not readable.
// nightly.yml already writes `with: { prefix-key: v1-nightly }` / `with: { tool: … }`
// (house style), so a scanner that reads ONLY block mappings FALSE-REDs a legitimately
// styled upload step (tooth U5a). Reading it means REAL key/value parsing, never a
// blanket "with: is flow-style → assume compliant" pass (tooth U5b), and a nested
// flow collection (whose commas this comma-splitter would misread) returns null so the
// caller fails closed rather than guessing.
function parseFlowMapping(value) {
  const open = value.indexOf('{');
  const close = value.lastIndexOf('}');
  if (open === -1 || close === -1 || close < open) return null;
  const inner = value.slice(open + 1, close);
  if (inner.indexOf('{') !== -1 || inner.indexOf('[') !== -1) return null;
  const pairs = [];
  for (const entry of inner.split(',')) {
    const text = entry.trim();
    if (text === '') continue;
    const kv = parseYamlKeyLine(text);
    if (kv === null) return null;
    pairs.push([kv.key, unquoteScalar(kv.value)]);
  }
  return pairs;
}

const UPLOAD_ARTIFACT_ACTION = 'actions/upload-artifact';

// A step is an UPLOAD step iff one of its OWN keys is `uses:` whose normalised value
// EQUALS actions/upload-artifact AND it has no `run:` key. The `run:` exclusion is what
// makes tooth O12 bite: a run step can print anything it likes into its block-scalar
// body, including a fake `uses:` line, and must never inherit the carve-out.
function stepIsUploadArtifact(step) {
  if (step.ownKeys.has('run')) return false;
  const uses = step.ownKeys.get('uses');
  if (uses === undefined) return false;
  return normaliseUsesValue(uses) === UPLOAD_ARTIFACT_ACTION;
}

// The ONLY two admitted `if:` values on an upload step (ADR-0200 D8). `success()`,
// `false` and every other expression RED (teeth O8, O9).
function isAlwaysCondition(value) {
  return value === 'always()' || /^\$\{\{\s*always\(\)\s*\}\}$/.test(value);
}

// Record a step's `with:` keys from EITHER form (tooth U5): the block form (`with:`
// with an empty value, keys on the following, more-indented lines) or the flow form
// (`with: { name: …, path: … }`). An unreadable flow value leaves withKeys empty, so
// the D7 path/name assertions fail closed instead of granting a blanket pass.
function collectWithKeys(step, value, blockChildIndent) {
  if (value === '') {
    step.withIndent = blockChildIndent;
    return;
  }
  const pairs = parseFlowMapping(value);
  if (pairs === null) return;
  for (const [key, val] of pairs) step.withKeys.set(key, val);
}

// Every key declared inside an `env:` mapping anywhere in a job block — job-level or
// step-level, block form or flow form (tooth U2). A `PATH` key there is the SAME
// toolchain-shim attack as U1's extra run step with no extra step to count: it
// prepends an attacker directory to PATH for the steps it covers, so the gate's
// `just` resolves to a shim that exits 0 while every existing predicate (exact
// run-step text, no if:, no continue-on-error) reads clean.
// Block-scalar bodies are skipped: a `run: |` body is DATA, not keys (tooth O13's
// discipline), so a script that happens to print `env:` cannot forge a finding.
function envMappingKeys(block) {
  const lines = block.split('\n');
  const keys = [];
  let blockScalarIndent = -1;
  let envIndent = -1;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    const indent = indentOfLine(raw);
    if (blockScalarIndent !== -1) {
      if (indent > blockScalarIndent) continue;
      blockScalarIndent = -1;
    }
    if (trimmed.startsWith('#')) continue;
    // A `- ` dash shifts the effective key column two to the right, so `- env:` at
    // indent 6 owns keys at indent 10 while its SIBLING keys sit at indent 8.
    const isDash = trimmed.startsWith('- ');
    const text = isDash ? trimmed.slice(2).trim() : trimmed;
    const keyIndent = isDash ? indent + 2 : indent;
    if (envIndent !== -1) {
      if (keyIndent > envIndent) {
        const envKv = parseYamlKeyLine(text);
        if (envKv !== null) {
          keys.push(envKv.key);
          if (isBlockScalarValue(envKv.value)) blockScalarIndent = keyIndent;
        }
        continue;
      }
      envIndent = -1;
    }
    const kv = parseYamlKeyLine(text);
    if (kv === null) continue;
    if (isBlockScalarValue(kv.value)) {
      blockScalarIndent = keyIndent;
      continue;
    }
    if (kv.key !== 'env') continue;
    if (kv.value === '') {
      envIndent = keyIndent;
      continue;
    }
    const pairs = parseFlowMapping(kv.value);
    // An unreadable flow `env:` value is reported as a PATH key so the caller fails
    // closed — an env: mapping this scanner cannot read must never read as clean.
    if (pairs === null) keys.push('PATH');
    else for (const [key] of pairs) keys.push(key);
  }
  return keys;
}

// Segment a strict job block into its job-level mapping entries and its steps.
// Returns { ok: true, jobLevel, steps } or { ok: false, reason } — the second form
// is the FAIL-CLOSED path for every shape this scanner cannot read.
//
// A step's OWN keys are its dash-line key plus the lines at stepIndent + 2. Anything
// deeper (a `with:` mapping, a block-scalar body) belongs to the step but is NOT an
// own key — which is what stops `if-no-files-found:` inside `with:` from being read as
// an `if:` (tooth O14) and stops a following step's `if:` from being misattributed to
// the upload step above it (tooth O4).
function segmentJobBlock(block, jobName) {
  const lines = block.split('\n');
  const jobIndent = indentOfLine(lines[0]);
  const childIndent = jobIndent + 2;

  // The `steps:` key is located by an ANCHORED whole-line match (trim() === 'steps:'),
  // never indexOf('steps:') — a `run: echo steps:` line would otherwise win the race
  // and move the job-level/step boundary wherever an attacker likes.
  let stepsIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (indentOfLine(lines[i]) !== childIndent) continue;
    if (trimmed === 'steps:') {
      stepsIdx = i;
      break;
    }
    const kv = parseYamlKeyLine(trimmed);
    if (kv !== null && kv.key === 'steps') {
      // `steps: [ { run: … } ]` — a flow sequence this scanner cannot read (tooth O22).
      return { ok: false, reason: `${jobName} uses a flow-style steps: sequence — unreadable` };
    }
  }
  if (stepsIdx === -1) {
    return { ok: false, reason: `${jobName} job block has no anchored steps: key line` };
  }

  const jobLevel = [];
  for (let i = 1; i < stepsIdx; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (isYamlIndirection(trimmed)) {
      return {
        ok: false,
        reason: `${jobName} job-level line uses a YAML alias/merge key: ${trimmed}`,
      };
    }
    const kv = parseYamlKeyLine(trimmed);
    if (kv !== null) jobLevel.push(kv);
  }

  // Step-dash indent is DERIVED from the first dash line, not assumed to be 6.
  let stepIndent = -1;
  for (let i = stepsIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed === '-' || trimmed.startsWith('- ')) {
      stepIndent = indentOfLine(lines[i]);
      break;
    }
  }
  if (stepIndent === -1) {
    return { ok: false, reason: `${jobName} steps: block contains no step dash` };
  }

  const steps = [];
  let current = null;
  // -1 = not inside a block scalar; otherwise the column of the key that opened it.
  let blockScalarKeyIndent = -1;
  for (let i = stepsIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    const indent = indentOfLine(raw);
    if (blockScalarKeyIndent !== -1) {
      if (indent > blockScalarKeyIndent) continue; // block-scalar BODY: data, not keys
      blockScalarKeyIndent = -1;
    }
    if (trimmed.startsWith('#')) continue;
    if (isYamlIndirection(trimmed)) {
      return { ok: false, reason: `${jobName} step line uses a YAML alias/merge key: ${trimmed}` };
    }
    if (indent === stepIndent && (trimmed === '-' || trimmed.startsWith('- '))) {
      const rest = trimmed === '-' ? '' : trimmed.slice(2).trim();
      if (rest.startsWith('{')) {
        return { ok: false, reason: `${jobName} has a flow-style step (- { … }) — unreadable` };
      }
      current = { ownKeys: new Map(), withKeys: new Map(), withIndent: -1 };
      steps.push(current);
      if (rest !== '') {
        const kv = parseYamlKeyLine(rest);
        if (kv !== null) {
          current.ownKeys.set(kv.key, kv.value);
          if (isBlockScalarValue(kv.value)) blockScalarKeyIndent = stepIndent + 2;
          if (kv.key === 'with') collectWithKeys(current, kv.value, stepIndent + 4);
        }
      }
      continue;
    }
    // A non-dash line back at (or above) job-child indent ENDS the steps sequence —
    // YAML mapping keys have no required order, so `if: false` parked BELOW `steps:`
    // is still a job-level neuter. Collecting it into jobLevel closes that hole; a
    // "job level == everything before steps:" reading would walk straight past it.
    if (indent <= childIndent) {
      const kv = parseYamlKeyLine(trimmed);
      if (kv !== null) jobLevel.push(kv);
      current = null;
      continue;
    }
    if (current === null) continue;
    if (indent === stepIndent + 2) {
      const kv = parseYamlKeyLine(trimmed);
      if (kv !== null) {
        current.ownKeys.set(kv.key, kv.value);
        if (isBlockScalarValue(kv.value)) blockScalarKeyIndent = indent;
        if (kv.key === 'with') collectWithKeys(current, kv.value, indent + 2);
      }
      continue;
    }
    if (current.withIndent !== -1 && indent === current.withIndent) {
      const kv = parseYamlKeyLine(trimmed);
      if (kv !== null) current.withKeys.set(kv.key, kv.value);
    }
  }

  return { ok: true, jobLevel, steps };
}

// Pure predicate: the named nightly job is not neutered.
// Returns { ok: boolean, reason: string }.
// Applied to mutation, coverage, mutation-server (NOT smoke-republish — its
// `if: failure()` log-dump step is legitimate; we do not call this on smoke-republish).
//
// STEP-SCOPED CARVE-OUT (ADR-0200 D8 — this REPLACES the old flat line scan, whose
// "any `if:` line anywhere in the block" rule made the D7 artifact step impossible).
// The scan is now segmented, and each clause kills a named attack:
//   - strictJobBlock, not extractJobBlock: a 2-space decoy comment can no longer
//     truncate the block and hide a neutered step below it (tooth O17).
//   - job-level region (everything before the anchored `steps:` line) rejects ANY
//     `if:` — a job-level condition is a neuter with no legitimate form (O6/O18/O19).
//   - `if:` on a step is admitted ONLY on an upload-artifact step (exact `uses:`
//     equality, no `run:` key) and ONLY when the value is `always()` or
//     `${{ always() }}` (O3/O5/O8/O9/O10/O11/O12).
//   - `continue-on-error:` is an ALLOWLIST: only the literal `false` passes. The old
//     truthy blacklist admitted `${{ github.event_name == 'schedule' }}` — false under
//     the workflow_dispatch a drill uses, true on every real cron night, i.e. a neuter
//     calibrated to hide from its own verification (tooth O20).
//   - unreadable shapes fail CLOSED: a missing `steps:` key, a missing step dash, a
//     flow step, a flow `steps:` sequence, a merge key or a bare alias
//     (O16/O21/O22/O23a/O23b).
export function jobIsNotNeutered(yaml, jobName) {
  const block = strictJobBlock(yaml, jobName);
  if (!block || block.trim() === '') {
    return { ok: false, reason: `${jobName} job block is empty or absent` };
  }
  const segmented = segmentJobBlock(block, jobName);
  if (!segmented.ok) {
    return { ok: false, reason: `${segmented.reason} — failing closed` };
  }

  for (const kv of segmented.jobLevel) {
    if (kv.key === 'if') {
      return {
        ok: false,
        reason: `${jobName} has a JOB-level if: ${kv.value} — can disable or skip the whole job`,
      };
    }
    if (kv.key === 'continue-on-error' && kv.value !== 'false') {
      return {
        ok: false,
        reason: `${jobName} has a job-level continue-on-error: ${kv.value} (only the literal false is allowed)`,
      };
    }
  }

  for (const step of segmented.steps) {
    const coe = step.ownKeys.get('continue-on-error');
    if (coe !== undefined && coe !== 'false') {
      return {
        ok: false,
        reason: `${jobName} has a step with continue-on-error: ${coe} (only the literal false is allowed)`,
      };
    }
    const condition = step.ownKeys.get('if');
    if (condition === undefined) continue;
    if (!stepIsUploadArtifact(step)) {
      return {
        ok: false,
        reason: `${jobName} has a non-upload step with if: ${condition} — the D8 carve-out is restricted to an actions/upload-artifact step`,
      };
    }
    if (!isAlwaysCondition(condition)) {
      return {
        ok: false,
        reason: `${jobName} upload step has if: ${condition} — only always() / \${{ always() }} is admitted`,
      };
    }
  }

  // U2 (round-3 BLOCKER) — no `PATH` key in ANY env: mapping in the job, job-level or
  // step-level. `env: { PATH: /tmp/.shim:$PATH }` prepends an attacker directory to the
  // search path for every step it covers, so `just mutate-core` resolves to a shim that
  // exits 0 while the exact-run-step-text / no-if / no-continue-on-error clauses above
  // all read clean. It needs no second step, so U1's ordering rule cannot see it.
  for (const key of envMappingKeys(block)) {
    if (key === 'PATH') {
      return {
        ok: false,
        reason: `${jobName} declares a PATH key inside an env: mapping — a PATH override shims the toolchain (a fake \`just\` that exits 0) without touching a single guarded key`,
      };
    }
  }

  // U1 (round-3 BLOCKER) — NO shell may execute before the gate invocation. Red-team's
  // full-eval bypass: a step BEFORE `- run: just mutate-core` writes `#!/bin/bash exit 0`
  // to /tmp/.shim/just and appends /tmp/.shim to "$GITHUB_PATH"; the recipe step then
  // resolves `just` to the shim and the mutation gate silently never runs, while every
  // pre-existing predicate reads clean.
  //
  // The rule is positional rather than the flat "AT MOST ONE run: step" the round-3
  // spec words it as, because tooth O13 (pre-existing, untouched) pins a job with a
  // SECOND run: step — a `run: |` diagnostic AFTER the gate — as legitimately ok. A
  // post-gate step cannot shim a binary the gate already invoked, so requiring the
  // gate to be the FIRST run: step kills exactly the attack class without contradicting
  // O13. It bites both U1 fixtures: the shim step (U1a) and a bare `- run: echo hi`
  // (U1b) are each a run: step preceding the gate.
  const runSteps = segmented.steps.filter((step) => step.ownKeys.has('run'));
  const gateIndex = runSteps.findIndex((step) => {
    const command = step.ownKeys.get('run').trim();
    return command === 'just' || command.startsWith('just ');
  });
  if (gateIndex === -1) {
    return {
      ok: false,
      reason: `${jobName} has no \`run: just <recipe>\` gate step — failing closed rather than guessing which step is the gate`,
    };
  }
  if (gateIndex > 0) {
    return {
      ok: false,
      reason: `${jobName} runs ${gateIndex} shell step(s) BEFORE its \`just\` gate step — a step that executes first can write a shim \`just\` (exit 0) onto $GITHUB_PATH and shadow the gate; the gate must be the FIRST run: step`,
    };
  }

  return { ok: true, reason: `${jobName} job is present and not neutered` };
}

// ---------------------------------------------------------------------------
// lp-03 NEW PREDICATES (ADR-0200 D3 / D6 / D7 — nightly failure notification)
// ---------------------------------------------------------------------------

// Returns the upload-artifact steps of a job, or null when the block is absent or
// unreadable. Shared by the D7 predicates so both read `uses:` the SAME way — the
// artifact checks must verify `uses:` THEMSELVES rather than assume jobIsNotNeutered
// already rejected a spoofed action upstream (teeth P7/P8).
function uploadArtifactSteps(yaml, jobName) {
  const block = strictJobBlock(yaml, jobName);
  if (!block || block.trim() === '') return null;
  const segmented = segmentJobBlock(block, jobName);
  if (!segmented.ok) return null;
  return segmented.steps.filter(stepIsUploadArtifact);
}

// Pure predicate (ADR-0200 D7): the named mutation job uploads mutants.out/ on a RED
// night. Returns { ok, reason }.
// A missing `if:` is a FAILURE, not a pass: the GitHub default is `success()`, which
// uploads the survivor list only on the nights it is worthless (tooth P2).
export function mutationJobUploadsMutantsOutOnFailure(yaml, jobName) {
  const uploads = uploadArtifactSteps(yaml, jobName);
  if (uploads === null) {
    return { ok: false, reason: `${jobName} job block is absent or unreadable` };
  }
  if (uploads.length === 0) {
    return {
      ok: false,
      reason: `${jobName} has no step whose uses: equals ${UPLOAD_ARTIFACT_ACTION} (a # comment mentioning it does not count)`,
    };
  }
  let reason = '';
  for (const step of uploads) {
    const condition = step.ownKeys.get('if');
    if (condition === undefined) {
      reason = `${jobName} upload step has NO if: — the default is success(), which skips the upload on the one night it matters`;
      continue;
    }
    if (!isAlwaysCondition(condition)) {
      reason = `${jobName} upload step has if: ${condition} — must be always() / \${{ always() }}`;
      continue;
    }
    const uploadPath = step.withKeys.get('path');
    if (uploadPath !== 'mutants.out/' && uploadPath !== 'mutants.out') {
      reason = `${jobName} upload step has path: ${uploadPath} — must be mutants.out/ (or mutants.out)`;
      continue;
    }
    const artifactName = step.withKeys.get('name');
    if (artifactName === undefined || artifactName.trim() === '') {
      reason = `${jobName} upload step has no non-empty name: — upload-artifact v4 requires one`;
      continue;
    }
    return { ok: true, reason: `${jobName} uploads ${uploadPath} as ${artifactName} on always()` };
  }
  return { ok: false, reason };
}

// Returns the first upload-artifact step's `name:` for a job, or null when there is no
// upload step or it carries no name. Returning null (rather than undefined) is
// load-bearing for tooth T3: a MISSING name must never compare "distinct" from the
// sibling job's real name.
function uploadArtifactName(yaml, jobName) {
  const uploads = uploadArtifactSteps(yaml, jobName);
  if (uploads === null || uploads.length === 0) return null;
  for (const step of uploads) {
    const artifactName = step.withKeys.get('name');
    if (artifactName !== undefined && artifactName.trim() !== '') return artifactName.trim();
  }
  return null;
}

// Pure predicate (ADR-0200 D7): the mutation and mutation-server upload steps use
// DISTINCT artifact names — upload-artifact v4 hard-errors on a duplicate name within
// one run, so identical names would turn the evidence upload itself into a red step.
export function notifyArtifactNamesAreDistinct(yaml) {
  const core = uploadArtifactName(yaml, 'mutation');
  const server = uploadArtifactName(yaml, 'mutation-server');
  if (core === null) {
    return { ok: false, reason: 'mutation job has no upload-artifact step with a non-empty name:' };
  }
  if (server === null) {
    return {
      ok: false,
      reason: 'mutation-server job has no upload-artifact step with a non-empty name:',
    };
  }
  if (core === server) {
    return { ok: false, reason: `mutation and mutation-server both upload as "${core}"` };
  }
  return { ok: true, reason: `artifact names are distinct: ${core} / ${server}` };
}

// Index of the top-level `jobs:` line (indent 0), or -1. A trailing comment on the
// mapping key is tolerated, matching jobHasFailurePolicyComment's clause 1.
function findJobsAnchor(lines) {
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln === 'jobs:' || ln.startsWith('jobs: ') || ln.startsWith('jobs:\t')) return i;
  }
  return -1;
}

// Every job key declared at the 2-space job-key indent under `jobs:`, in file order.
// DERIVED from the file — never a hardcoded list — so an unwired sixth job REDs the
// day it is added (tooth R2).
function declaredJobKeys(yaml) {
  const lines = yaml.split('\n');
  const jobsIdx = findJobsAnchor(lines);
  if (jobsIdx === -1) return [];
  const keys = [];
  for (let i = jobsIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = indentOfLine(raw);
    if (indent === 0) break;
    if (indent !== 2) continue;
    const kv = parseYamlKeyLine(trimmed);
    if (kv !== null && kv.value === '') keys.push(kv.key);
  }
  return keys;
}

// Does the block spanning [start, end) contain a LIVE `issues: write` key?
// Comment lines are excluded — a commented-out grant is not a grant (tooth Q4) — and
// `issues: read` is not a write grant (tooth Q5).
function linesGrantIssuesWrite(lines, start, end) {
  for (let i = start; i < end && i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const kv = parseYamlKeyLine(trimmed);
    if (kv !== null && kv.key === 'issues' && kv.value === 'write') return true;
  }
  return false;
}

// The workflow-level `permissions:` block, as { found, grantsIssuesWrite }.
// The anchor tolerates a trailing comment / trailing whitespace on the mapping key
// line (`permissions: # least privilege — see ADR-0200`), matching findJobsAnchor and
// jobHasFailurePolicyComment's clause 1. An EXACT `=== 'permissions:'` match made a
// legally-commented grant invisible and false-RED'd the whole notify wiring (tooth U6a).
function topLevelPermissions(yaml) {
  const lines = yaml.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const anchor = lines[i];
    if (
      anchor !== 'permissions:' &&
      !anchor.startsWith('permissions: ') &&
      !anchor.startsWith('permissions:\t')
    ) {
      continue;
    }
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const trimmed = lines[j].trim();
      if (trimmed === '') continue;
      if (indentOfLine(lines[j]) === 0) {
        end = j;
        break;
      }
    }
    return { found: true, grantsIssuesWrite: linesGrantIssuesWrite(lines, i + 1, end) };
  }
  return { found: false, grantsIssuesWrite: false };
}

// A job's OWN `permissions:` block (at job-child indent only, so a step's keys can
// never be mistaken for it), as { found, grantsIssuesWrite }.
function jobOwnPermissions(block) {
  const lines = block.split('\n');
  const childIndent = indentOfLine(lines[0]) + 2;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() !== 'permissions:') continue;
    if (indentOfLine(lines[i]) !== childIndent) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const trimmed = lines[j].trim();
      if (trimmed === '') continue;
      if (indentOfLine(lines[j]) <= childIndent) {
        end = j;
        break;
      }
    }
    return { found: true, grantsIssuesWrite: linesGrantIssuesWrite(lines, i + 1, end) };
  }
  return { found: false, grantsIssuesWrite: false };
}

// Pure predicate (ADR-0200 D3): the `notify` job EFFECTIVELY holds `issues: write`.
// A job-level `permissions:` block REPLACES the workflow-level one in GitHub's real
// semantics, so a notify job with its OWN block that omits `issues:` is INEFFECTIVE
// even when the top level grants it — an "OR both blocks together" implementation
// misses that (tooth Q6).
export function nightlyNotifyCanOpenIssues(yaml) {
  const block = strictJobBlock(yaml, 'notify');
  if (!block || block.trim() === '') {
    return { ok: false, reason: 'no notify: job exists' };
  }
  const own = jobOwnPermissions(block);
  if (own.found) {
    return own.grantsIssuesWrite
      ? { ok: true, reason: "notify's own permissions: block grants issues: write" }
      : {
          ok: false,
          reason:
            'notify has its OWN permissions: block without issues: write — a job-level block REPLACES the workflow-level one, so any top-level grant is dead here',
        };
  }
  const top = topLevelPermissions(yaml);
  return top.grantsIssuesWrite
    ? { ok: true, reason: 'notify inherits issues: write from the workflow-level permissions:' }
    : {
        ok: false,
        reason:
          'issues: write is granted nowhere (notify declares no permissions: and the workflow-level block does not grant it)',
      };
}

// Pure predicate (ADR-0200 D3, negative space): no job other than `notify`, and not the
// top-level block, carries a live `issues: write`.
// PER-JOB ATTRIBUTION, never a whole-file occurrence count: tooth S4 declares notify
// FIRST (valid own grant) and mutation SECOND (illegitimate grant), so a
// first-occurrence / last-occurrence / total-count implementation reads it as clean.
export function noOtherJobHoldsIssuesWrite(yaml) {
  const lines = yaml.split('\n');
  const jobsIdx = findJobsAnchor(lines);
  let owner = 'the top-level permissions: block';
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (jobsIdx !== -1 && i > jobsIdx && indentOfLine(raw) === 2) {
      const jobKv = parseYamlKeyLine(trimmed);
      if (jobKv !== null && jobKv.value === '') owner = jobKv.key;
    }
    const kv = parseYamlKeyLine(trimmed);
    if (kv === null || kv.key !== 'issues' || kv.value !== 'write') continue;
    if (owner !== 'notify') {
      return { ok: false, reason: `issues: write is held by ${owner}` };
    }
  }
  return { ok: true, reason: 'issues: write is held by the notify job only' };
}

// Pure predicate (ADR-0200 D1/D2/D2a/D5/D6): the notify job is genuinely wired.
// This gates the ENUMERATION, not merely "a gh issue create line exists" — a single
// hardcoded create call satisfies "a step exists" while failing every EARS clause about
// attribution (teeth R10-R14).
export function nightlyNotifyIsWired(yaml) {
  const block = strictJobBlock(yaml, 'notify');
  if (!block || block.trim() === '') {
    return { ok: false, reason: 'no notify: job exists' };
  }
  const blockLines = block.split('\n');
  const childIndent = indentOfLine(blockLines[0]) + 2;

  // Clause 1 — needs: must cover EVERY other declared job key, derived from the file.
  let needs = null;
  for (let i = 1; i < blockLines.length; i++) {
    const trimmed = blockLines[i].trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (indentOfLine(blockLines[i]) !== childIndent) continue;
    const kv = parseYamlKeyLine(trimmed);
    if (kv === null || kv.key !== 'needs') continue;
    if (kv.value.startsWith('[')) {
      // Flow form: needs: [a, b, c]
      const close = kv.value.lastIndexOf(']');
      const inner = close === -1 ? kv.value.slice(1) : kv.value.slice(1, close);
      needs = inner
        .split(',')
        .map((entry) => entry.trim().replace(/^['"]/, '').replace(/['"]$/, ''))
        .filter((entry) => entry !== '');
    } else if (kv.value === '') {
      // Block-sequence form.
      needs = [];
      for (let j = i + 1; j < blockLines.length; j++) {
        const item = blockLines[j].trim();
        if (item === '' || item.startsWith('#')) continue;
        if (indentOfLine(blockLines[j]) <= childIndent) break;
        if (!item.startsWith('- ')) break;
        needs.push(item.slice(2).trim().replace(/^['"]/, '').replace(/['"]$/, ''));
      }
    }
    break;
  }
  if (needs === null) {
    return { ok: false, reason: 'notify job has no needs: key' };
  }
  const required = declaredJobKeys(yaml).filter((key) => key !== 'notify');
  const missing = required.filter((key) => !needs.includes(key));
  if (missing.length > 0) {
    return { ok: false, reason: `notify needs: omits declared job(s): ${missing.join(', ')}` };
  }

  // Clause 2 — the job-level if: must admit BOTH failure and skipped (ADR-0200 D2a).
  // A bare failure() leaves notify skipped when a job is neutered into `skipped`
  // (tooth R3b); a bare always() fires on green nights and would red D6's zero-guard
  // every single night (tooth R3c).
  let condition = null;
  let jobLevelCoe = null;
  for (let i = 1; i < blockLines.length; i++) {
    const trimmed = blockLines[i].trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const kv = parseYamlKeyLine(trimmed);
    if (kv === null) continue;
    if (kv.key === 'if' && indentOfLine(blockLines[i]) === childIndent) condition = kv.value;
    if (kv.key === 'continue-on-error') jobLevelCoe = kv.value;
  }
  if (condition === null) {
    return {
      ok: false,
      reason:
        'notify job has no job-level if: — it would only run on the (never-happens) all-succeeded path',
    };
  }
  // U3 — match the RUNTIME condition, not the raw line. `if: true # …failure…skipped…`
  // evaluates to the bare `true` (YAML drops the trailing comment), so scanning the raw
  // text launders ANY condition through its own comment: notify would then fire on every
  // green night and red D6's zero-guard nightly (tooth U3a).
  const conditionCode = stripInlineYamlComment(condition);
  // Each term must appear as a QUOTED result literal — `contains(needs.*.result,
  // 'cancelled')` — never as the bare `cancelled()` FUNCTION. The `!cancelled()` guard
  // that every compliant condition carries contains the substring "cancelled", so an
  // unquoted indexOf would score the two-term form as three-term (tooth U3b).
  const admitsResult = (term) =>
    conditionCode.indexOf(`'${term}'`) !== -1 || conditionCode.indexOf(`"${term}"`) !== -1;
  // `cancelled` is the third required term as of lp-03 round 3: a timeout-minutes expiry
  // concludes `cancelled` (smoke-republish carries a 20-minute timeout; the mutation jobs
  // run 1.5-2.5h against the 6h hosted cap) and satisfies neither `failure` nor `skipped`,
  // so a two-term condition leaves that whole class of red night silent.
  const missingTerms = ['failure', 'skipped', 'cancelled'].filter((term) => !admitsResult(term));
  if (missingTerms.length > 0) {
    return {
      ok: false,
      reason: `notify job-level if: ${conditionCode} does not admit ${missingTerms.join(' + ')} as a quoted needs.*.result value (ADR-0200 D2a)`,
    };
  }
  if (jobLevelCoe !== null && jobLevelCoe !== 'false') {
    return {
      ok: false,
      reason: `notify carries continue-on-error: ${jobLevelCoe} — a soft-failing notifier is a silently broken one`,
    };
  }

  // LIVE lines only: text living inside a `#` comment is not executable code, so a
  // commented-out `gh issue create` must not satisfy anything (teeth R14, P5-style).
  const live = blockLines.filter((ln) => ln.trim() !== '' && !ln.trim().startsWith('#'));
  const liveText = live.join('\n');

  if (liveText.indexOf('|| true') !== -1) {
    return { ok: false, reason: 'notify body softens a command with `|| true`' };
  }
  if (liveText.indexOf('set +e') !== -1) {
    return { ok: false, reason: 'notify body disables error handling with `set +e`' };
  }
  if (liveText.indexOf('toJSON(needs)') === -1) {
    return {
      ok: false,
      reason:
        'notify body never reads toJSON(needs) — the failing set must be ENUMERATED, never hardcoded (ADR-0200 D2)',
    };
  }

  const createLines = live.filter((ln) => ln.indexOf('gh issue create') !== -1);
  if (createLines.length === 0) {
    return { ok: false, reason: 'notify body never calls gh issue create as live code' };
  }
  // U4 — EXACTLY one live invocation. The EARS clause is "SHALL NOT open more than one
  // issue per job"; a lower bound alone lets a second create inside the same enumeration
  // loop double-file every failing job, turning the notification into noise the team
  // learns to ignore — the same silence the ADR exists to fix (tooth U4a).
  if (createLines.length > 1) {
    return {
      ok: false,
      reason: `notify body calls gh issue create ${createLines.length} times as live code — exactly one invocation is admitted (never more than one issue per enumerated job)`,
    };
  }

  // Clause 4 — per-job attribution: the create call must reference the ENUMERATED job,
  // not open one generic issue per run (tooth R11).
  let loopVar = null;
  for (const ln of live) {
    const match = ln.match(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/);
    if (match) {
      loopVar = match[1];
      break;
    }
  }
  if (loopVar === null) {
    return { ok: false, reason: 'notify body has no per-job enumeration loop' };
  }
  const attributed = createLines.some(
    (ln) => ln.indexOf(`$${loopVar}`) !== -1 || ln.indexOf(`\${${loopVar}`) !== -1,
  );
  if (!attributed) {
    return {
      ok: false,
      reason: `gh issue create never references the enumerated job ($${loopVar}) — every issue would be generically titled`,
    };
  }

  // Clause 5 — the issue must LINK THE RUN. The link is traced from the env vars whose
  // VALUE is derived from github.run_id, so a body that merely mentions a job name
  // without a run reference REDs (tooth R12).
  const runVars = [];
  for (const ln of live) {
    const kv = parseYamlKeyLine(ln.trim());
    if (kv !== null && kv.value.indexOf('github.run_id') !== -1) runVars.push(kv.key);
  }
  const linksRun = createLines.some((ln) =>
    runVars.some((v) => ln.indexOf(`$${v}`) !== -1 || ln.indexOf(`\${${v}`) !== -1),
  );
  if (!linksRun) {
    return {
      ok: false,
      reason:
        'gh issue create never references a run id / run URL env var derived from github.run_id',
    };
  }

  // Clause 6 — D6's zero-enumerated guard: a notifier that fires and quietly opens
  // nothing is indistinguishable from a green night (tooth R13).
  const hasZeroTest = live.some(
    (ln) => ln.indexOf('-eq 0') !== -1 || ln.indexOf('== 0') !== -1 || ln.indexOf('-lt 1') !== -1,
  );
  const hasExit1 = live.some((ln) => ln.indexOf('exit 1') !== -1);
  if (!hasZeroTest || !hasExit1) {
    return {
      ok: false,
      reason: 'notify body has no zero-enumerated `exit 1` guard (ADR-0200 D6)',
    };
  }

  return { ok: true, reason: 'notify job fans in over every job and enumerates per-job issues' };
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
// WHY A COMMENT *AS WELL AS* A NOTIFIER: decision-hook mdrewt/claude-harness#14
// (nightly failure notification channel) was answered in lp-03 — ADR-0200 ships a
// `notify` job that opens one GitHub issue per non-success job via `gh` (D1/D2/D5).
// This preamble gate is NOT superseded by it: the issue says WHICH job failed, the
// preamble says WHAT HAPPENS NEXT (routing/priority, ADR-0050), and only the latter
// survives in the repo where a reader of the workflow can find it. Both are required.
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
  // lp-03 ROUND 3: extended from a two-term to a THREE-term condition (TEETH U3).
  // A job that concludes `cancelled` (a timeout-minutes expiry — smoke-republish
  // carries one, and the mutation jobs run 1.5-2.5h against a 6h hosted cap)
  // satisfied neither `failure` nor `skipped` under the old two-term form, so
  // notify stayed silent on that class of red-and-silent night. The old
  // two-term string now lives inline at TEETH U3b as a dedicated NEGATIVE fixture.
  const NOTIFY_D2A_IF =
    "if: ${{ !cancelled() && (contains(needs.*.result, 'failure') || contains(needs.*.result, 'skipped') || contains(needs.*.result, 'cancelled')) }}";

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
  // lp-03 ROUND 3 PROOF-OF-TEETH (red-team BLOCKER bypass + code-reviewer/
  // GH-Actions-semantics-auditor holes + false-RED guards). Section letters
  // continue as TEETH U, immediately after TEETH T, so as not to renumber
  // A-T. Every predicate under test here (jobIsNotNeutered,
  // mutationJobUploadsMutantsOutOnFailure, nightlyNotifyIsWired,
  // nightlyNotifyCanOpenIssues) already EXISTS and is GREEN on the committed
  // tree — this section pins FIVE new rules none of them yet enforce, so
  // every negative fixture below REDs against the CURRENT committed predicate
  // bodies until the specialist closes each rule.
  // =========================================================================

  // -------------------------------------------------------------------------
  // TEETH U1: jobIsNotNeutered — a guarded job may contain AT MOST ONE `run:`
  // step. Red-team's full-eval bypass: a step BEFORE `- run: just
  // mutate-core` writes a `just` shim (`exit 0`) onto $GITHUB_PATH, so the
  // real recipe step's `just` resolves to the shim and the mutation gate
  // silently never runs — while every EXISTING predicate (a single exact
  // `- run: just mutate-core` line, no if:, no continue-on-error) still reads
  // clean. "Exactly one run: step" is what closes it: a second `run:` step of
  // ANY kind in a guarded job is itself the neuter, regardless of its body.
  // -------------------------------------------------------------------------

  // U1a — the literal red-team shim fixture (a $GITHUB_PATH-poisoning step
  // BEFORE the real recipe step). [NOT ok]
  const u1ShimBypass = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - name: Prep just runner
        run: |
          mkdir -p /tmp/.shim
          printf '#!/bin/bash\\nexit 0\\n' > /tmp/.shim/just
          chmod +x /tmp/.shim/just
          echo "/tmp/.shim" >> "$GITHUB_PATH"
      - run: just mutate-core
`;
  {
    const r = jobIsNotNeutered(u1ShimBypass, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH U1a (BLOCKER): jobIsNotNeutered accepted a job with a $GITHUB_PATH-poisoning ' +
          'step BEFORE the exact "- run: just mutate-core" step — this is the red-team full-eval ' +
          'bypass: a shim `just` binary that exits 0 shadows the real recipe, and every existing ' +
          'predicate (exact run-step text, no if:, no continue-on-error) reads clean while the ' +
          'mutation gate never actually runs. A guarded job may contain AT MOST ONE run: step.',
      };
    }
  }

  // U1b — no shim, just a second, unrelated run: step. Kills an impl that
  // special-cases "GITHUB_PATH" text instead of counting run: steps — the
  // rule is a step-count invariant, not a text blacklist. [NOT ok]
  const u1TwoRunSteps = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
      - run: just mutate-core
`;
  {
    const r = jobIsNotNeutered(u1TwoRunSteps, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH U1b: jobIsNotNeutered accepted a job with TWO run: steps ("- run: echo hi" then ' +
          '"- run: just mutate-core") — a second run: step of ANY kind (not just a $GITHUB_PATH ' +
          'shim) must be rejected; the rule is a step-count invariant, not a text blacklist',
      };
    }
  }

  // U1c — POSITIVE CONTROL: the real canonical shape (several uses: steps,
  // EXACTLY one run: step, and the D8-carved-out if: always() upload step).
  // Must stay ok — a false RED here would block every legitimate mutation-job
  // edit. [ok]
  const u1CanonicalOneRunStep = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v4
      - uses: actions-rs/toolchain@abc1234abc1234abc1234abc1234abc1234abc12 # v1
      - run: just mutate-core
      - name: Upload mutants.out (failure evidence)
        if: always()
        uses: ${UPLOAD_USES}
        with:
          name: mutants-out-core
          path: mutants.out/
          if-no-files-found: warn
          retention-days: 14
`;
  {
    const r = jobIsNotNeutered(u1CanonicalOneRunStep, 'mutation');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH U1c: jobIsNotNeutered rejected the canonical mutation job shape (uses: steps + exactly one run: step + the if: always() upload step) — a false RED here would block every legitimate future edit. Reason: ${r.reason}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // TEETH U2: jobIsNotNeutered — no `PATH` key in ANY env: mapping inside a
  // guarded job. Same attack class as U1 but with zero extra steps: a
  // job-level (or step-level) env: PATH override achieves the identical
  // shim-shadowing with no second run: step to catch and no if:/
  // continue-on-error at all.
  // -------------------------------------------------------------------------

  // U2a — job-level env: PATH override. [NOT ok]
  const u2JobLevelPathEnv = `jobs:
  mutation:
    runs-on: ubuntu-latest
    env:
      PATH: /tmp/.shim:$PATH
    steps:
      - run: just mutate-core
`;
  {
    const r = jobIsNotNeutered(u2JobLevelPathEnv, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH U2a (BLOCKER): jobIsNotNeutered accepted a job-level env: PATH: /tmp/.shim:$PATH ' +
          '— this prepends an attacker directory onto PATH for every step in the job, achieving the ' +
          'same `just` shim-shadowing as U1 with a SINGLE run: step and no if:/continue-on-error at ' +
          'all. No env: mapping inside a guarded job may declare a PATH key.',
      };
    }
  }

  // U2b — step-level env: PATH override on the recipe step itself. Kills an
  // impl that only inspects job-level env: mappings. [NOT ok]
  const u2StepLevelPathEnv = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - name: Run mutate-core
        env:
          PATH: /tmp/.shim:$PATH
        run: just mutate-core
`;
  {
    const r = jobIsNotNeutered(u2StepLevelPathEnv, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH U2b (BLOCKER): jobIsNotNeutered accepted a STEP-level env: PATH: /tmp/.shim:$PATH ' +
          'on the recipe step — job-level env: is not the only place a PATH override can hide',
      };
    }
  }

  // U2c — POSITIVE CONTROL: job-level AND step-level env: carrying only
  // ORDINARY, non-PATH keys. Must stay ok — a false RED here would block
  // legitimate future edits (RUST_BACKTRACE / CARGO_TERM_COLOR are real env
  // vars this project's CI already sets elsewhere). [ok]
  const u2OrdinaryEnvKeys = `jobs:
  mutation:
    runs-on: ubuntu-latest
    env:
      RUST_BACKTRACE: '1'
    steps:
      - name: Run mutate-core
        env:
          CARGO_TERM_COLOR: always
        run: just mutate-core
`;
  {
    const r = jobIsNotNeutered(u2OrdinaryEnvKeys, 'mutation');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH U2c: jobIsNotNeutered rejected job-level + step-level env: mappings carrying only ordinary non-PATH keys (RUST_BACKTRACE, CARGO_TERM_COLOR) — a false RED here would block legitimate future edits. Reason: ${r.reason}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // TEETH U3: nightlyNotifyIsWired's D2a condition check — comment-laundering
  // and the `cancelled` gap. Red-team proved `if: true # per D2a this admits
  // both failure and skipped semantics` passes today because the D2a check
  // matches condition.indexOf('failure')/'skipped') against the RAW line
  // text, including its inline comment; at runtime the comment is stripped
  // and the condition IS the bare `true`, so notify fires on EVERY night,
  // including green ones, which REDs D6's zero-guard every single night.
  // Separately, a `cancelled` conclusion (a timeout-minutes expiry —
  // smoke-republish carries one, and the mutation jobs run 1.5-2.5h against a
  // 6h hosted cap) satisfies neither `failure` nor `skipped`, so a bare
  // two-term condition leaves a real red-and-silent hole. The canonical
  // condition is now a three-term `!cancelled() && (failure OR skipped OR
  // cancelled)` (see the updated NOTIFY_D2A_IF constant above).
  // -------------------------------------------------------------------------

  // U3a — comment-laundering: the literal red-team fixture. The condition
  // VALUE is `true` at runtime; only its trailing # comment mentions
  // failure/skipped. [NOT ok]
  const u3LaunderedCondition = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs: [mutation, mutation-server, coverage]
    if: true # per D2a this admits both failure and skipped semantics
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}${NOTIFY_CANONICAL_STEPS}`;
  {
    const r = nightlyNotifyIsWired(u3LaunderedCondition);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH U3a (BLOCKER): nightlyNotifyIsWired accepted "if: true # per D2a this admits both ' +
          'failure and skipped semantics" — the condition VALUE is the bare `true` at runtime ' +
          "(YAML strips the inline comment); reading condition.indexOf('failure')/'skipped') " +
          'against the RAW line text (comment included) launders ANY condition through its own ' +
          "comment. This fires notify on every green night and REDs D6's zero-guard nightly.",
      };
    }
  }

  // U3b — a real, no-comment condition that admits only failure + skipped,
  // with NO cancelled term. This was the OLD canonical form (pre-round-3); it
  // is now non-compliant — a job concluding `cancelled` satisfies neither
  // term, so the notifier stays silent on that class of red night. [NOT ok]
  const u3TwoTermNoCancelled =
    "if: ${{ !cancelled() && (contains(needs.*.result, 'failure') || contains(needs.*.result, 'skipped')) }}";
  const u3NoCancelledFixture = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs: [mutation, mutation-server, coverage]
    ${u3TwoTermNoCancelled}
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}${NOTIFY_CANONICAL_STEPS}`;
  {
    const r = nightlyNotifyIsWired(u3NoCancelledFixture);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH U3b: nightlyNotifyIsWired accepted a condition covering only failure + skipped ' +
          "with NO third contains(needs.*.result, 'cancelled') term — smoke-republish carries a " +
          'timeout-minutes and the mutation jobs run 1.5-2.5h against a 6h hosted cap, so a job ' +
          'concluding `cancelled` satisfies neither term and notify stays silent',
      };
    }
  }

  // U3c — POSITIVE CONTROL: the new canonical three-term condition (the
  // shared NOTIFY_D2A_IF constant, updated this round). Must stay ok. [ok]
  const u3CanonicalFixture = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs: [mutation, mutation-server, coverage]
    ${NOTIFY_D2A_IF}
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}${NOTIFY_CANONICAL_STEPS}`;
  {
    const r = nightlyNotifyIsWired(u3CanonicalFixture);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH U3c: nightlyNotifyIsWired rejected the new canonical three-term condition (!cancelled() && (failure OR skipped OR cancelled)). Reason: ${r.reason}`,
      };
    }
  }

  // U3d — R3b (bare failure() alone) and R3c (bare always() alone) are
  // UNCHANGED by this round and are NOT re-declared here; they still run
  // earlier in this file (TEETH R, above) and still expect [NOT ok].

  // -------------------------------------------------------------------------
  // TEETH U4: nightlyNotifyIsWired — EXACTLY ONE live `gh issue create`
  // invocation per enumerated job (EARS "SHALL NOT open more than one issue
  // per job"). This clause has no dedicated tooth today: the predicate only
  // checks createLines.length === 0 (a lower bound), never an upper bound.
  // -------------------------------------------------------------------------

  // U4a — TWO live gh issue create lines inside the enumeration loop, both
  // attributed to the same enumerated $job. [NOT ok]
  const u4TwoCreatesPerJob = `name: Nightly
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
            gh issue create --title "nightly failure: $job (1)" --body "Job $job failed. See $RUN_URL"
            gh issue create --title "nightly failure: $job (2)" --body "Job $job failed. See $RUN_URL"
            opened=$((opened + 1))
          done
          if [ "$opened" -eq 0 ]; then
            echo "notify fired but enumerated zero failing jobs" >&2
            exit 1
          fi
`;
  {
    const r = nightlyNotifyIsWired(u4TwoCreatesPerJob);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH U4a: nightlyNotifyIsWired accepted a notify body with TWO live "gh issue create" ' +
          'lines inside the per-job enumeration loop, both attributed to the same $job — the EARS ' +
          'clause is "SHALL NOT open more than one issue per job", and the predicate today only ' +
          'checks createLines.length === 0 (a lower bound), never an upper bound',
      };
    }
  }

  // U4b — POSITIVE CONTROL: the canonical single-create body. Already
  // covered by TEETH R8/R9 and Q1/Q2 above (all compose NOTIFY_CANONICAL_STEPS,
  // which contains exactly one live gh issue create line) — not re-declared here.

  // -------------------------------------------------------------------------
  // TEETH U5: flow-style `with:` on the upload step — a false-RED guard, not
  // a blanket accept. nightly.yml already uses `with: { key: value }` flow
  // style for several actions (house style, not an exotic form), so
  // jobIsNotNeutered and mutationJobUploadsMutantsOutOnFailure must both read
  // it — but reading it means REAL key/value parsing, not "flow-style with:
  // → assume ok".
  // -------------------------------------------------------------------------

  // U5a — POSITIVE CONTROL: the canonical upload step written with
  // flow-style with:. Must be accepted by BOTH predicates. [ok / ok]
  const u5FlowUploadCanonical = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload mutants.out (failure evidence)
        if: always()
        uses: ${UPLOAD_USES}
        with: { name: mutants-out-core, path: mutants.out/, if-no-files-found: warn, retention-days: 14 }
`;
  {
    const rNeuter = jobIsNotNeutered(u5FlowUploadCanonical, 'mutation');
    if (!rNeuter.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH U5a-neuter: jobIsNotNeutered rejected the canonical upload step written with flow-style with: { ... } — nightly.yml already uses this style for several actions (house style, not exotic). Reason: ${rNeuter.reason}`,
      };
    }
    const rUpload = mutationJobUploadsMutantsOutOnFailure(u5FlowUploadCanonical, 'mutation');
    if (!rUpload.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH U5a-upload: mutationJobUploadsMutantsOutOnFailure rejected the canonical upload step written with flow-style with: { ... } — a false RED that would block committing house style. Reason: ${rUpload.reason}`,
      };
    }
  }

  // U5b — NEGATIVE: flow-style with: whose path: is coverage/ (not
  // mutants.out/). Proves flow parsing reads the ACTUAL key/value pairs
  // rather than granting a blanket pass to any step whose with: happens to
  // be flow-style. [NOT ok]
  const u5FlowUploadWrongPath = `jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
      - name: Upload mutants.out (failure evidence)
        if: always()
        uses: ${UPLOAD_USES}
        with: { name: mutants-out-core, path: coverage/, if-no-files-found: warn, retention-days: 14 }
`;
  {
    const r = mutationJobUploadsMutantsOutOnFailure(u5FlowUploadWrongPath, 'mutation');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH U5b: mutationJobUploadsMutantsOutOnFailure accepted a flow-style with: { ... } ' +
          'whose path: is coverage/ (not mutants.out/) — flow-style acceptance must be REAL ' +
          'parsing of the mapping, not a blanket accept keyed only on the with: being flow-style',
      };
    }
  }

  // -------------------------------------------------------------------------
  // TEETH U6: nightlyNotifyCanOpenIssues — a false-RED guard for a trailing
  // comment on the top-level `permissions:` key line. topLevelPermissions
  // finds the block by an EXACT `lines[i] !== 'permissions:'` line match, so
  // `permissions: # least privilege — see ADR-0200` (legal YAML — a trailing
  // comment on a mapping key) is invisible to it today.
  // -------------------------------------------------------------------------

  // U6a — top-level `permissions:` line carries a trailing comment; notify
  // has NO own permissions: block (so it must inherit the top-level grant).
  // [ok]
  const u6PermissionsTrailingComment = `name: Nightly
on:
  workflow_dispatch:
permissions: # least privilege — see ADR-0200
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
    const r = nightlyNotifyCanOpenIssues(u6PermissionsTrailingComment);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH U6a: nightlyNotifyCanOpenIssues rejected a top-level "permissions: # least privilege — see ADR-0200" line (a trailing comment is legal YAML on a mapping key) with issues: write declared under it and no own permissions: block on notify — a false RED that would block a legitimately commented workflow. Reason: ${r.reason}`,
      };
    }
  }

  // =========================================================================
  // 16r-c PROOF-OF-TEETH (ADR-0196 changelog-freshness gate). Section letters
  // continue as TEETH V (D1 — the gate is declared, ordered and un-neutered)
  // and TEETH W (D2 — the git-cliff pin agrees across justfile + workflow),
  // immediately after TEETH U, so TEETH A-U are neither touched nor
  // renumbered. Every constant and predicate under test below is called
  // FORWARD to code the specialist has not written yet: the first reference
  // (TEETH V0) throws a ReferenceError, which evals/run.mjs records as this
  // eval's pass:false. That IS the deliberate RED.
  // =========================================================================

  // -------------------------------------------------------------------------
  // TEETH V: jobIsNotNeutered's ordered `opts.gates` descriptors,
  // CHANGELOG_FRESHNESS_GATES, nightlyDeclaresJob,
  // nightlyJobStructureIsUnambiguous, nightlyHasNoWorkflowScopeNeuters.
  //
  // WHY A VERBATIM BODY PIN AND NOT A NEEDLE LIST. The red-team's proven
  // BLOCKER against every needle formulation is tooth V12: replace the entire
  // gating-suite body with ONE inert line that merely MENTIONS the real
  // command, and "mentions node --test" / "mentions --test-reporter=tap" /
  // "mentions exit 1" are all satisfied by a step that executes nothing. Only
  // EQUALITY against a pinned constant kills it — the same
  // MUTATE_SERVER_CAP_BASELINE discipline applied to text instead of a number.
  //
  // WHY EVERY FIXTURE IS RENDERED FROM THAT CONSTANT. A hand-copied positive
  // control drifts silently the day the suite body changes: V1 would keep
  // passing against a stale copy while the REAL job no longer matches the pin,
  // i.e. the eval would ship a pin that false-REDs the committed tree. Building
  // the fixtures out of CHANGELOG_FRESHNESS_GATES makes V1 a ROUND TRIP — "the
  // pinned text, re-emitted as YAML, must read back as the pinned text" — so
  // the pin cannot drift away from its own positive control.
  // -------------------------------------------------------------------------

  // V0 — FIXTURE-INTEGRITY BACKSTOP (the L-bigcap-backstop precedent). Every
  // fixture below is derived from CHANGELOG_FRESHNESS_GATES, so a DEGENERATE
  // pin silently guts this whole section: with `[]` every gates loop matches
  // vacuously and V6/V7/V8/V9/V10/V11/V12 all go inert while still "passing".
  // The shape is therefore asserted before anything uses it. The three content
  // needles are the ones a softened PIN would have to drop in order to
  // verbatim-match a softened workflow — pinning the *pin* is the point: this
  // gate can only be lowered by editing a constant, in a diff a human reads.
  {
    const gates = CHANGELOG_FRESHNESS_GATES;
    const shapeOk =
      Array.isArray(gates) &&
      gates.length === 2 &&
      gates.every((g) => g !== null && typeof g === 'object' && g.kind === 'script') &&
      typeof gates[0].text === 'string' &&
      typeof gates[1].text === 'string';
    if (!shapeOk) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V0: CHANGELOG_FRESHNESS_GATES is not an array of exactly two ' +
          "{ kind: 'script', text } descriptors — every TEETH V fixture is rendered from it, so a " +
          'degenerate pin (an empty array, a function-valued gate, a missing text) would make ' +
          'V6-V12 vacuously pass while measuring nothing',
      };
    }
    if (gates[1].text !== 'node scripts/changelog-freshness.mjs --check') {
      return {
        name,
        pass: false,
        detail:
          `TEETH V0: CHANGELOG_FRESHNESS_GATES[1].text is "${gates[1].text}" — the second gate is ` +
          'pinned to the EXACT string `node scripts/changelog-freshness.mjs --check`; a pin that ' +
          'admits a softened form (`… --check || true`) would verbatim-match a softened workflow ' +
          'and this eval would report the softening as compliant',
      };
    }
    const suite = gates[0].text;
    if (
      suite.split('\n').length < 2 ||
      suite.split('\n')[0].indexOf('node --test') === -1 ||
      suite.indexOf('| tee') === -1 ||
      suite.indexOf('exit 1') === -1
    ) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V0: CHANGELOG_FRESHNESS_GATES[0].text does not look like the committed gating ' +
          "suite (first line running `node --test`, a `| tee` capture, and an `exit 1` failure " +
          'path over at least two lines). Tooth V11 is built by keeping ONLY that first line, so a ' +
          'one-line or floor-less pin makes V11 identical to V1 and the verbatim-body proof inert',
      };
    }
  }

  // The pinned gate texts, used to RENDER every changelog-freshness fixture
  // below (never hand-copied out of nightly.yml — see the section header).
  const V_SUITE_BODY = CHANGELOG_FRESHNESS_GATES[0].text;
  const V_CHECK_CMD = CHANGELOG_FRESHNESS_GATES[1].text;

  // Render one `run:` step at the house step indent. A single-line body with no
  // extra own keys is emitted as the bare `- run: <scalar>` form the real file
  // uses for the `--check` step; anything else becomes `name:` + own keys +
  // `run: |` block scalar, which is the real file's shape for the gating suite.
  // Both spellings must normalise to the SAME live run text — that equivalence
  // is itself part of the contract (V1 uses one of each).
  const vRunStep = (body, ownKeys = []) => {
    if (body.indexOf('\n') === -1 && ownKeys.length === 0) return `      - run: ${body}\n`;
    const keys = ownKeys.map((k) => `        ${k}\n`).join('');
    const scalar = body
      .split('\n')
      .map((ln) => `          ${ln}`)
      .join('\n');
    return `      - name: gate step\n${keys}        run: |\n${scalar}\n`;
  };

  // Render a whole workflow around a changelog-freshness job.
  //   opts.topLevel — extra top-level mapping text spliced between `on:` and `jobs:`
  //   opts.keyTail  — text appended to the job KEY line (a legal trailing comment)
  //   opts.jobKeys  — extra job-level keys (4-space indented, already newline-terminated)
  // The two leading `uses:` steps are load-bearing, not decoration: they prove the
  // gates array indexes RUN steps, not steps in general.
  const vJob = (steps, opts = {}) => `name: Nightly
on:
  workflow_dispatch:
${opts.topLevel ?? ''}jobs:
  # Failure policy for \`changelog-freshness\`: triaged and inserted as the next
  # slice in the milestone queue, same tier as fix-red-master, below it in ordering.
  changelog-freshness:${opts.keyTail ?? ''}
    runs-on: ubuntu-latest
${opts.jobKeys ?? ''}    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v6
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@abc1234abc1234abc1234abc1234abc1234abc12 # v7
        with: { node-version: '24.13.1' }
${steps.join('')}`;

  const V_SUITE_STEP = vRunStep(V_SUITE_BODY, ['shell: bash']);
  const V_CHECK_STEP = vRunStep(V_CHECK_CMD);
  const V_CANONICAL_STEPS = [V_SUITE_STEP, V_CHECK_STEP];
  const V_GATES = { gates: CHANGELOG_FRESHNESS_GATES };
  const vCanonical = vJob(V_CANONICAL_STEPS);

  // V1 — THE MOST IMPORTANT FIXTURE IN THIS SECTION. The canonical job, rendered
  // from the pin itself, under the pin. It forbids shipping a
  // CHANGELOG_FRESHNESS_GATES value that would false-RED the committed tree:
  // Check 27 runs the same predicate against the real nightly.yml, and a pin
  // that cannot accept its own round trip cannot accept the real file either.
  // [ok]
  {
    const r = jobIsNotNeutered(vCanonical, 'changelog-freshness', V_GATES);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH V1: jobIsNotNeutered rejected the canonical changelog-freshness job RENDERED FROM CHANGELOG_FRESHNESS_GATES itself — the pin must accept its own round trip, or it will false-RED the committed workflow at Check 27. Reason: ${r.reason}`,
      };
    }
  }

  // V2 — step-level `continue-on-error: true` on the `--check` step. Kills a
  // gates implementation that verifies run TEXT and forgets to keep running the
  // pre-existing soft-failure allowlist over the same steps. [NOT ok]
  {
    const fixture = vJob([V_SUITE_STEP, vRunStep(V_CHECK_CMD, ['continue-on-error: true'])]);
    const r = jobIsNotNeutered(fixture, 'changelog-freshness', V_GATES);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V2: jobIsNotNeutered accepted continue-on-error: true on the ' +
          '`node scripts/changelog-freshness.mjs --check` step — the drift check would report its ' +
          'red as a green job; only the literal false is admitted',
      };
    }
  }

  // V3 — job-level `continue-on-error: true`. [NOT ok]
  {
    const fixture = vJob(V_CANONICAL_STEPS, { jobKeys: '    continue-on-error: true\n' });
    const r = jobIsNotNeutered(fixture, 'changelog-freshness', V_GATES);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V3: jobIsNotNeutered accepted a JOB-level continue-on-error: true on ' +
          'changelog-freshness — the whole job would report success no matter what either gate step did',
      };
    }
  }

  // V3b — the O20 CALIBRATED neuter, retargeted at this job: a
  // continue-on-error expression that reads false under the workflow_dispatch a
  // verification drill uses and true on every real cron night. This tooth
  // exists to prove the ADR-0200 D8 ALLOWLIST is INHERITED by the gates path
  // rather than re-implemented next to it as a truthy blacklist. [NOT ok]
  {
    const fixture = vJob([
      V_SUITE_STEP,
      vRunStep(V_CHECK_CMD, ["continue-on-error: ${{ github.event_name == 'schedule' }}"]),
    ]);
    const r = jobIsNotNeutered(fixture, 'changelog-freshness', V_GATES);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V3b: jobIsNotNeutered accepted continue-on-error: ' +
          "${{ github.event_name == 'schedule' }} on a changelog-freshness gate step — false under " +
          'the workflow_dispatch a drill uses, true on every real cron night, i.e. a neuter ' +
          'calibrated to hide from its own verification. The D8 allowlist (only the literal false) ' +
          'must be INHERITED by the gates path, not re-implemented beside it',
      };
    }
  }

  // V4 — job-level `if: false` (the EARS "disabled" mode). [NOT ok]
  {
    const fixture = vJob(V_CANONICAL_STEPS, { jobKeys: '    if: false\n' });
    const r = jobIsNotNeutered(fixture, 'changelog-freshness', V_GATES);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail: 'TEETH V4: jobIsNotNeutered accepted a job-level if: false on changelog-freshness',
      };
    }
  }

  // V5 — `if: false` on the `--check` step only. The job still runs, still
  // reports success, and the drift check never executes. [NOT ok]
  {
    const fixture = vJob([V_SUITE_STEP, vRunStep(V_CHECK_CMD, ['if: false'])]);
    const r = jobIsNotNeutered(fixture, 'changelog-freshness', V_GATES);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V5: jobIsNotNeutered accepted if: false on the `--check` step — the D8 carve-out ' +
          'admits an if: ONLY on an actions/upload-artifact step, and this job has none',
      };
    }
  }

  // V6 — the TEETH U1 shim bypass retargeted at this job: a $GITHUB_PATH-poisoning
  // step BEFORE the gating suite. Kills a generalisation that swapped the
  // "gate must be the FIRST run: step" positional rule for a set-membership
  // test while widening jobIsNotNeutered to take gates. [NOT ok]
  {
    const fixture = vJob([
      vRunStep('echo /tmp/.shim >> "$GITHUB_PATH"'),
      V_SUITE_STEP,
      V_CHECK_STEP,
    ]);
    const r = jobIsNotNeutered(fixture, 'changelog-freshness', V_GATES);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V6: jobIsNotNeutered accepted a `- run: echo /tmp/.shim >> "$GITHUB_PATH"` step ' +
          'BEFORE the gating suite — a step that executes first can shim `node` (or `git`) and ' +
          'shadow both gates while their run text matches the pin byte for byte. gates[k] must ' +
          'match the k-th run: step, so a pre-gate step is itself the neuter (the U1 rule, kept)',
      };
    }
  }

  // V7 — the two gate steps REORDERED. Running the drift check BEFORE its own
  // test suite is not a cosmetic difference: the suite is the countermeasure
  // that proves the checker still has teeth, and a checker that has silently
  // gone vacuous exits 0 first, so the reordered job goes green on a broken
  // checker. Kills a set-based / unordered "every gate matches SOME run step"
  // matcher. [NOT ok]
  {
    const fixture = vJob([V_CHECK_STEP, V_SUITE_STEP]);
    const r = jobIsNotNeutered(fixture, 'changelog-freshness', V_GATES);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V7: jobIsNotNeutered accepted the two gate steps in REVERSED order — `opts.gates` ' +
          'is an ORDERED array (gates[k] pins the k-th run: step); an unordered set-membership ' +
          'matcher reads a reordered job as compliant',
      };
    }
  }

  // V8 — gating suite DELETED, `--check` step remains. [NOT ok]
  {
    const fixture = vJob([V_CHECK_STEP]);
    const r = jobIsNotNeutered(fixture, 'changelog-freshness', V_GATES);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V8: jobIsNotNeutered accepted a changelog-freshness job whose TAP gating suite ' +
          'step was deleted — without it a checker whose own tests have gone vacuous still exits ' +
          '0 and the drift gate measures nothing',
      };
    }
  }

  // V9 — `--check` step DELETED, suite remains. Complementary to V8 by
  // construction: a one-sided implementation (one that verifies only gates[0],
  // or only "some step matches the last gate") passes exactly ONE of V8/V9, so
  // the pair cannot both be satisfied by a half-built loop. [NOT ok]
  {
    const fixture = vJob([V_SUITE_STEP]);
    const r = jobIsNotNeutered(fixture, 'changelog-freshness', V_GATES);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V9: jobIsNotNeutered accepted a changelog-freshness job whose ' +
          '`node scripts/changelog-freshness.mjs --check` step was deleted, leaving only the ' +
          'suite — the job would then test the checker and never RUN it',
      };
    }
  }

  // V10 — `--check` softened with `|| true`. Kills substring/indexOf matching
  // of the gate text (the F6 discipline, restated for script gates). [NOT ok]
  {
    const fixture = vJob([V_SUITE_STEP, vRunStep(`${V_CHECK_CMD} || true`)]);
    const r = jobIsNotNeutered(fixture, 'changelog-freshness', V_GATES);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V10: jobIsNotNeutered accepted `node scripts/changelog-freshness.mjs --check || ' +
          'true` — the normalised live run text must EQUAL the pinned gate text; an indexOf/' +
          'startsWith comparison admits every `|| true`, `; exit 0` and `&& true` suffix',
      };
    }
  }

  // V11 — THE FIXTURE THAT PROVES THE VERBATIM BODY PIN. The suite body keeps
  // its first line (the real `node --test … | tee` invocation) and DROPS the TAP
  // pass-count floor that follows. Under a substring/needle matcher V1 and V11
  // are indistinguishable — both "mention node --test" — yet this one is the
  // documented zero-test hole: `node --test <file>` exits 0 when a file defines
  // no tests, so without the floor the suite passes on an empty test file. Built
  // by DERIVATION from the pin (first line only), never hand-copied; V0 refuses
  // to run if that derivation would produce the whole body. [NOT ok]
  {
    const fixture = vJob([
      vRunStep(V_SUITE_BODY.split('\n')[0], ['shell: bash']),
      V_CHECK_STEP,
    ]);
    const r = jobIsNotNeutered(fixture, 'changelog-freshness', V_GATES);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V11: jobIsNotNeutered accepted a gating-suite step that runs `node --test … | ' +
          'tee` but DROPS the TAP pass-count floor — `node --test` exits 0 on a file that defines ' +
          'no tests at all, so the floor is the semantic half of the countermeasure. A needle ' +
          'matcher cannot tell this fixture from V1; only equality against the pinned body can',
      };
    }
  }

  // V12 — THE RED-TEAM'S PROVEN BLOCKER. The entire suite body replaced by ONE
  // inert line that merely MENTIONS the real command and its failure mode. It
  // beats any needle list ever proposed for this gate: it "mentions node --test",
  // it "mentions the test file", it "mentions exit 1", and it executes nothing.
  // Written as a LITERAL on purpose — a decoy derived from the pin would stop
  // being a decoy. [NOT ok]
  {
    const inert =
      'echo "node --test scripts/changelog-freshness.test.mjs prints \'# pass N\'; on drift we exit 1"';
    const fixture = vJob([vRunStep(inert, ['shell: bash']), V_CHECK_STEP]);
    const r = jobIsNotNeutered(fixture, 'changelog-freshness', V_GATES);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V12 (BLOCKER): jobIsNotNeutered accepted a gating-suite step whose whole body is ' +
          'a single `echo` NAMING the real command — every needle-list formulation of this gate ' +
          '("mentions node --test", "mentions the test file", "mentions exit 1") is satisfied by a ' +
          'step that runs nothing. Only EQUALITY against CHANGELOG_FRESHNESS_GATES[0].text kills it',
      };
    }
  }

  // V12b — the REAL suite body, present verbatim, wrapped in `if false; then …
  // fi`. Kills an implementation that normalises the body to a SET of lines, or
  // one that asks "does the pinned text appear inside the step body" instead of
  // "is the step body the pinned text". [NOT ok]
  {
    const wrapped = `if false; then\n${V_SUITE_BODY.split('\n')
      .map((ln) => `  ${ln}`)
      .join('\n')}\nfi`;
    const fixture = vJob([vRunStep(wrapped, ['shell: bash']), V_CHECK_STEP]);
    const r = jobIsNotNeutered(fixture, 'changelog-freshness', V_GATES);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V12b: jobIsNotNeutered accepted the real gating-suite body wrapped in ' +
          '`if false; then … fi` — the pinned text is present in full and executes never; the ' +
          'comparison must be equality over the normalised body, not containment',
      };
    }
  }

  // V13 — canonical PLUS an extra POST-gate `- run: |` diagnostic step. The
  // O13 analogue for this job: run steps after the last gate stay legal (a step
  // that runs AFTER both gates cannot shim a binary they already invoked), so an
  // "exactly N run: steps" implementation is wrong and this fixture says so.
  // A false RED here would block every future diagnostic addition. [ok]
  {
    const diagnostic = vRunStep('echo "tap tail:"\ntail -n 5 /tmp/changelog-freshness.tap');
    const fixture = vJob([V_SUITE_STEP, V_CHECK_STEP, diagnostic]);
    const r = jobIsNotNeutered(fixture, 'changelog-freshness', V_GATES);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH V13: jobIsNotNeutered rejected an extra POST-gate diagnostic run: step — gates[k] pins the k-th run: step for k = 0..gates.length-1 and says nothing about later steps (tooth O13 pins the same rule for the mutation job). Reason: ${r.reason}`,
      };
    }
  }

  // V14 — the `--check` step carries `shell: 'true {0}'`. GitHub then runs
  // `true <script-path>`: the step exits 0 having executed NOTHING, while the
  // run text still equals the pin byte for byte. This is the one neuter a
  // perfect run-text pin cannot see, which is why the gate-step shell key is
  // itself allowlisted. [NOT ok]
  {
    const fixture = vJob([V_SUITE_STEP, vRunStep(V_CHECK_CMD, ["shell: 'true {0}'"])]);
    const r = jobIsNotNeutered(fixture, 'changelog-freshness', V_GATES);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          "TEETH V14: jobIsNotNeutered accepted `shell: 'true {0}'` on a gate step — GitHub runs " +
          '`true <script>`, so the step exits 0 having executed nothing while its run: text still ' +
          'matches the pin exactly. A gate step may carry no shell: other than the literal bash',
      };
    }
  }

  // V14b — FALSE-RED GUARD: `shell: bash` on a gate step. The committed gating
  // suite carries exactly that, deliberately, for the `-o pipefail` it brings
  // (without it `node --test | tee` discards node's exit status). Rejecting it
  // would false-RED the real workflow at Check 27. [ok]
  {
    const fixture = vJob([V_SUITE_STEP, vRunStep(V_CHECK_CMD, ['shell: bash'])]);
    const r = jobIsNotNeutered(fixture, 'changelog-freshness', V_GATES);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH V14b: jobIsNotNeutered rejected \`shell: bash\` on a gate step — bash is the ONE admitted value (the committed suite uses it for -o pipefail); banning shell: outright is a false RED on the real workflow. Reason: ${r.reason}`,
      };
    }
  }

  // V15 — DEFAULT-PATH BYTE-EQUIVALENCE CONTROL. The third parameter is
  // ADDITIVE: omitting it, and passing an empty object, must both behave
  // exactly as today's two-parameter predicate did. The fixture is TEETH U1c's
  // canonical mutation job, reused deliberately — if the default path has
  // drifted, this fails on the same shape U1c already pins as ok. [ok / ok]
  {
    const rNoOpts = jobIsNotNeutered(u1CanonicalOneRunStep, 'mutation');
    if (!rNoOpts.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH V15-omitted: jobIsNotNeutered(yaml, 'mutation') with NO third argument rejected the canonical mutation job — the opts parameter is ADDITIVE and its default [{ kind: 'just' }] must be byte-equivalent to the pre-16r-c behaviour. Reason: ${rNoOpts.reason}`,
      };
    }
    const rEmptyOpts = jobIsNotNeutered(u1CanonicalOneRunStep, 'mutation', {});
    if (!rEmptyOpts.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH V15-empty: jobIsNotNeutered(yaml, 'mutation', {}) rejected the canonical mutation job — an opts object with no gates key must fall back to the default [{ kind: 'just' }], not to an empty gate list or a fail-closed. Reason: ${rEmptyOpts.reason}`,
      };
    }
  }

  // V16 — an UNRECOGNISED gate kind must FAIL CLOSED. A `switch` whose default
  // arm falls through to "matched" turns every future typo'd descriptor into a
  // silently disabled gate; the fixture is otherwise a perfectly healthy job, so
  // only the unknown kind can be what bites. [NOT ok]
  {
    const r = jobIsNotNeutered(u1CanonicalOneRunStep, 'mutation', { gates: [{ kind: 'wat' }] });
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          "TEETH V16: jobIsNotNeutered accepted an unrecognised gate descriptor { kind: 'wat' } " +
          'against an otherwise-healthy job — an unknown kind must fail CLOSED; a default arm that ' +
          'falls through to "matched" disables the gate silently for every future typo',
      };
    }
  }

  // V17 — nightlyDeclaresJob POSITIVE CONTROL. [ok]
  {
    const r = nightlyDeclaresJob(vCanonical, 'changelog-freshness');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH V17: nightlyDeclaresJob rejected a workflow that declares changelog-freshness at 2-space indent under jobs:. Reason: ${r.reason}`,
      };
    }
  }

  // V18 — the EARS "deleted" mode: the job is gone entirely AND removed from
  // notify's needs:, so `nightlyNotifyIsWired` (which derives its required set
  // from the file) reads the workflow as perfectly consistent. That is the
  // whole point — deletion is invisible to every other predicate in this file,
  // which is why presence needs its own check. [NOT ok]
  {
    const vJobDeleted = `name: Nightly
on:
  workflow_dispatch:
jobs:
${R_SIBLING_JOBS}  notify:
    needs: [mutation, mutation-server, coverage]
    ${NOTIFY_D2A_IF}
    runs-on: ubuntu-latest
${NOTIFY_PERMISSIONS}${NOTIFY_CANONICAL_STEPS}`;
    const r = nightlyDeclaresJob(vJobDeleted, 'changelog-freshness');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V18: nightlyDeclaresJob accepted a workflow with NO changelog-freshness job — the ' +
          'job is deleted and also removed from notify\'s needs:, so the fan-in predicate reads ' +
          'the file as internally consistent and nothing else in this eval notices the deletion',
      };
    }
  }

  // V19 — the job key exists ONLY as a comment (`  # changelog-freshness:`).
  // Kills an indexOf-presence implementation. [NOT ok]
  {
    const vKeyOnlyInComment = `name: Nightly
on:
  workflow_dispatch:
jobs:
  # changelog-freshness:
  #   runs-on: ubuntu-latest
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
`;
    const r = nightlyDeclaresJob(vKeyOnlyInComment, 'changelog-freshness');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V19: nightlyDeclaresJob accepted a commented-out `  # changelog-freshness:` key — ' +
          'a commented job is not a job; presence must be a LIVE mapping key, never an indexOf hit',
      };
    }
  }

  // V20 — a 2-space `changelog-freshness:` key under `on:` rather than `jobs:`
  // (the tooth M8 anchoring lesson, restated for presence). [NOT ok]
  {
    const vKeyUnderOn = `name: Nightly
on:
  changelog-freshness:
  workflow_dispatch:
jobs:
  mutation:
    runs-on: ubuntu-latest
    steps:
      - run: just mutate-core
`;
    const r = nightlyDeclaresJob(vKeyUnderOn, 'changelog-freshness');
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V20: nightlyDeclaresJob accepted a 2-space `changelog-freshness:` key declared ' +
          'under `on:` rather than under `jobs:` — the key scan must be ANCHORED at the top-level ' +
          'jobs: line, or a colliding key anywhere in the file satisfies the gate',
      };
    }
  }

  // V21 — FALSE-RED GUARD: a legal trailing comment on the job key line.
  // `declaredJobKeys` drops such a key today (it requires kv.value === ''), so a
  // presence check built by copying that helper would REJECT a perfectly valid,
  // well-annotated workflow. [ok]
  {
    const fixture = vJob(V_CANONICAL_STEPS, { keyTail: ' # ledger drift, ADR-0196' });
    const r = nightlyDeclaresJob(fixture, 'changelog-freshness');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH V21: nightlyDeclaresJob rejected "  changelog-freshness: # ledger drift, ADR-0196" — a trailing comment on a mapping key is legal YAML and is tolerated by findJobsAnchor / jobHasFailurePolicyComment clause 1; declaredJobKeys' kv.value === '' test drops it, and copying that test here is a false RED. Reason: ${r.reason}`,
      };
    }
  }

  // V22 — nightlyJobStructureIsUnambiguous: the job declared TWICE, the second
  // copy `if: false`. A real YAML parser is LAST-WINS, so GitHub runs the
  // neutered copy; every text scanner in this file is FIRST-WINS, so
  // strictJobBlock hands each predicate the healthy copy and the whole eval
  // reads green. Nothing else in this file can see this. [NOT ok]
  {
    const vDuplicateJobKey = `${vCanonical}  changelog-freshness:
    if: false
    runs-on: ubuntu-latest
    steps:
      - run: echo neutered
`;
    const r = nightlyJobStructureIsUnambiguous(vDuplicateJobKey);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V22: nightlyJobStructureIsUnambiguous accepted a workflow declaring ' +
          'changelog-freshness TWICE at 2-space indent, the second copy carrying if: false — YAML ' +
          'is last-wins and this file\'s scanners are first-wins, so GitHub runs the neutered ' +
          'definition while every predicate here inspects the healthy one',
      };
    }
  }

  // V23 — a SECOND top-level `jobs:` mapping. findJobsAnchor returns the FIRST
  // one, so every job under the second mapping is unreachable to this eval while
  // being the mapping GitHub actually uses. Fail closed. [NOT ok]
  {
    const vTwoJobsMappings = `${vCanonical}jobs:
  changelog-freshness:
    if: false
    runs-on: ubuntu-latest
    steps:
      - run: echo neutered
`;
    const r = nightlyJobStructureIsUnambiguous(vTwoJobsMappings);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V23: nightlyJobStructureIsUnambiguous accepted a workflow with TWO top-level ' +
          'jobs: mappings — findJobsAnchor takes the first, GitHub takes the last, and every ' +
          'job-scoped predicate in this file is then reading a mapping that never runs',
      };
    }
  }

  // V24 — POSITIVE CONTROL on a healthy workflow. [ok]
  {
    const r = nightlyJobStructureIsUnambiguous(vCanonical);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH V24: nightlyJobStructureIsUnambiguous rejected a workflow with exactly one jobs: mapping and no duplicate job keys — a false RED here blocks every edit to nightly.yml. Reason: ${r.reason}`,
      };
    }
  }

  // V25 — nightlyHasNoWorkflowScopeNeuters: a top-level `defaults: run: shell:
  // 'true {0}'`. This no-ops EVERY run step in EVERY job — all five gates at
  // once — and is structurally invisible to every job-scoped scanner in this
  // file, including the V14 gate-step shell rule, because it declares no shell:
  // key inside any job. [NOT ok]
  {
    const fixture = vJob(V_CANONICAL_STEPS, {
      topLevel: "defaults:\n  run:\n    shell: 'true {0}'\n",
    });
    const r = nightlyHasNoWorkflowScopeNeuters(fixture);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          "TEETH V25: nightlyHasNoWorkflowScopeNeuters accepted a top-level defaults: run: shell: " +
          "'true {0}' — GitHub then runs `true <script>` for EVERY run step in EVERY job, so all " +
          'five nightly gates exit 0 having executed nothing, and no job-scoped scanner can see it',
      };
    }
  }

  // V26 — a `PATH` key inside the top-level `env:` mapping: the TEETH U2 shim
  // attack hoisted to workflow scope, where the per-job env scan never looks.
  // [NOT ok]
  {
    const fixture = vJob(V_CANONICAL_STEPS, {
      topLevel: 'env:\n  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true\n  PATH: /tmp/.shim:$PATH\n',
    });
    const r = nightlyHasNoWorkflowScopeNeuters(fixture);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH V26: nightlyHasNoWorkflowScopeNeuters accepted a top-level env: PATH: ' +
          '/tmp/.shim:$PATH — the same shim-shadowing tooth U2 kills inside a job, hoisted one ' +
          'level up where it covers all five gates and no job-scoped env scan reaches it',
      };
    }
  }

  // V27 — FALSE-RED GUARD: the REAL shape. The committed nightly.yml has a
  // top-level env: mapping carrying exactly one key
  // (FORCE_JAVASCRIPT_ACTIONS_TO_NODE24). Banning top-level env: outright, or
  // treating any top-level env: as suspicious, false-REDs the committed tree at
  // Check 25 — the rule is a PATH key, not the mapping. [ok]
  {
    const fixture = vJob(V_CANONICAL_STEPS, {
      topLevel: 'env:\n  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true\n',
    });
    const r = nightlyHasNoWorkflowScopeNeuters(fixture);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH V27: nightlyHasNoWorkflowScopeNeuters rejected the REAL committed shape (a top-level env: whose only key is FORCE_JAVASCRIPT_ACTIONS_TO_NODE24) — the rule is "no PATH key in the top-level env:", not "no top-level env:". Reason: ${r.reason}`,
      };
    }
  }

  // V28 — FALSE-RED GUARD: a COMMENTED `# defaults:` block. Comment lines must
  // neither satisfy nor trip the rule — the same live-lines-only discipline
  // teeth Q4 and R14 pin elsewhere in this file. [ok]
  {
    const fixture = vJob(V_CANONICAL_STEPS, {
      topLevel: "# defaults:\n#   run:\n#     shell: 'true {0}'\n",
    });
    const r = nightlyHasNoWorkflowScopeNeuters(fixture);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH V28: nightlyHasNoWorkflowScopeNeuters rejected a workflow whose only defaults: text is a # COMMENT — a commented-out neuter is not a neuter, and rejecting it blocks documenting why the key is deliberately absent. Reason: ${r.reason}`,
      };
    }
  }

  // -------------------------------------------------------------------------
  // TEETH V — EQUIVALENT MUTANTS, DECLARED RATHER THAN TESTED. Each of these
  // would be a fixture that exercises a code path ALREADY pinned by an existing
  // tooth; writing them would grow the file without adding a single bite, and
  // an inert tooth is worse than no tooth because it reads as coverage:
  //   - `env: PATH:` INSIDE the changelog-freshness job (job- or step-level).
  //     jobIsNotNeutered's env scan is job-name-agnostic — it runs
  //     envMappingKeys over the extracted block — so this is byte-identical to
  //     the path teeth U2a/U2b/U2c already pin, with the job name swapped.
  //   - the fail-closed unreadable-shape clauses for this job (no steps: key,
  //     no step dash, a flow-style step, a flow steps: sequence, a merge key, a
  //     bare alias). Teeth O16/O21/O22/O23a/O23b pin them in segmentJobBlock,
  //     which every caller shares; a changelog-freshness copy tests the same
  //     lines through the same door.
  //   - the upload-artifact `if: always()` carve-out. This job has no upload
  //     step, so a carve-out fixture here would assert nothing about it.
  //   - the k = 1..n-1 ordering loop under the DEFAULT one-element gates array.
  //     For mutation / mutation-server / coverage the array has length 1 BY
  //     CONSTRUCTION, so the loop body past k = 0 is unreachable for those jobs.
  //     It is exercised only through CHANGELOG_FRESHNESS_GATES — which is why
  //     V7/V8/V9 carry the entire ordering proof for the whole predicate.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // TEETH W: GIT_CLIFF_PINNED_VERSION, CHANGELOG_RECIPE_BODY, gitCliffPinsAgree.
  //
  // The justfile recipe and the workflow's install step both produce the
  // CHANGELOG.md that the freshness checker diffs against. When they drift, an
  // upstream rendering change flips every entry to missing+extra at once and
  // REDs the gate for a reason unrelated to freshness — the nag-then-bypass mode
  // ADR-0165 rejected, arriving through the back door.
  //
  // EVERY fixture derives its version from GIT_CLIFF_PINNED_VERSION and its
  // recipe from CHANGELOG_RECIPE_BODY, so a re-pin is a one-constant edit and
  // no fixture rots (the TEETH L cap-boundary lesson).
  //
  // CONTRACT NOTE FOR CHANGELOG_RECIPE_BODY: it is the recipe body AS IT APPEARS
  // IN THE FILE — carrying its 4-space recipe indentation, lines joined with
  // \n, trailing newlines insignificant. W1 splices it straight under a
  // `changelog:` header, so clause (c) is a ROUND TRIP: whatever the extractor
  // reads back out of a real justfile must equal the constant. The body's first
  // line `#!/usr/bin/env bash` is NOT a comment to be stripped — it makes this a
  // just SHEBANG recipe, and dropping it changes execution from a single script
  // to line-by-line, which silently discards `set -euo pipefail`. A body
  // extractor copied from mutateServerRecipeIntact (which drops #-lines) will
  // fail W1 for exactly that reason.
  // -------------------------------------------------------------------------

  // A version that must NEVER equal the pin — the backstop below refuses to run
  // in a world where it does (the L-bigcap-backstop precedent: a drift fixture
  // that stops drifting goes inert silently).
  const W_DRIFTED = '1.0.0';
  if (W_DRIFTED === GIT_CLIFF_PINNED_VERSION) {
    return {
      name,
      pass: false,
      detail:
        `TEETH W-backstop: the drift fixture version W_DRIFTED=${W_DRIFTED} equals ` +
        `GIT_CLIFF_PINNED_VERSION — every "pins disagree" fixture in TEETH W would silently ` +
        'become a positive control. Pick a different W_DRIFTED',
    };
  }

  const W_PIN = GIT_CLIFF_PINNED_VERSION;

  // A sibling recipe whose name has `changelog` as a strict PREFIX, declared
  // FIRST on purpose: a body extractor keyed on startsWith('changelog') rather
  // than on the exact `changelog:` header line reads THIS recipe's body and
  // compares the wrong text.
  const W_CHECK_RECIPE_BODY = `    #!/usr/bin/env bash
    set -euo pipefail
    want="git-cliff {{GIT_CLIFF_VERSION}}"
    if [ "$(git cliff --version 2>/dev/null || true)" != "$want" ]; then
        echo "changelog-check: git-cliff version mismatch — want '$want'" >&2
        exit 1
    fi
    node scripts/changelog-freshness.mjs --check
`;

  // Trailing newlines are normalised away so the fixture is a valid justfile
  // whichever convention the constant ships with; the INDENTATION is not
  // normalised, because that is the half of the round trip worth pinning.
  const wJustfile = (assignments, recipeBody) => `# fixture justfile (16r-c TEETH W)
${assignments}

changelog-check:
${W_CHECK_RECIPE_BODY}
changelog:
${recipeBody.replace(/\n+$/, '')}

ci: lint typecheck test eval
`;

  const W_INSTALL_FLOW = (tool) => `      - uses: taiki-e/install-action@abc1234abc1234abc1234abc1234abc1234abc12 # v2
        with: { tool: ${tool} }
`;
  const W_INSTALL_BLOCK = (tool) => `      - uses: taiki-e/install-action@abc1234abc1234abc1234abc1234abc1234abc12 # v2
        with:
          tool: ${tool}
`;

  // The workflow side. A `coverage` job sits above changelog-freshness so every
  // negative fixture can park a decoy pin in a DIFFERENT job: clause (b) must
  // read the pin through strictJobBlock + segmentJobBlock + withKeys, never by
  // an indexOf over the whole file.
  const wNightly = (freshnessInstall, coverageInstall = '') => `name: Nightly
on:
  workflow_dispatch:
jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v6
${coverageInstall}      - run: just coverage
  changelog-freshness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v6
        with: { fetch-depth: 0 }
${freshnessInstall}      - run: node scripts/changelog-freshness.mjs --check
`;

  const W_LIVE_PIN_ASSIGN = `GIT_CLIFF_VERSION := "${W_PIN}"`;
  const W_CANONICAL_JUSTFILE = wJustfile(W_LIVE_PIN_ASSIGN, CHANGELOG_RECIPE_BODY);
  const W_CANONICAL_NIGHTLY = wNightly(W_INSTALL_FLOW(`git-cliff@${W_PIN}`));

  // W1 — POSITIVE CONTROL: both sides pinned to the constant, recipe body equal
  // to CHANGELOG_RECIPE_BODY. Like V1 this is a round trip, and like V1 it
  // forbids shipping constants that would false-RED the committed tree once the
  // justfile is written. [ok]
  {
    const r = gitCliffPinsAgree(W_CANONICAL_JUSTFILE, W_CANONICAL_NIGHTLY);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH W1: gitCliffPinsAgree rejected a justfile and workflow that BOTH pin git-cliff to GIT_CLIFF_PINNED_VERSION with a changelog: body spliced straight from CHANGELOG_RECIPE_BODY — the constants must accept their own round trip. Reason: ${r.reason}`,
      };
    }
  }

  // W2 — the JUSTFILE side drifts. The reason must name BOTH values, so a red
  // says which side moved (the justfileCapEqualsCeiling precedent). [NOT ok]
  {
    const drifted = wJustfile(`GIT_CLIFF_VERSION := "${W_DRIFTED}"`, CHANGELOG_RECIPE_BODY);
    const r = gitCliffPinsAgree(drifted, W_CANONICAL_NIGHTLY);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          `TEETH W2: gitCliffPinsAgree accepted justfile GIT_CLIFF_VERSION=${W_DRIFTED} against ` +
          `GIT_CLIFF_PINNED_VERSION=${W_PIN} — a local regeneration would then write a CHANGELOG.md ` +
          'the nightly job cannot reproduce',
      };
    }
    if (r.reason.indexOf(W_DRIFTED) === -1 || r.reason.indexOf(W_PIN) === -1) {
      return {
        name,
        pass: false,
        detail:
          `TEETH W2-reason: gitCliffPinsAgree reported a drift without naming both values ` +
          `(expected ${W_DRIFTED} and ${W_PIN} in the reason, got: ${r.reason}) — a red that does ` +
          'not say which side drifted sends the reader to the wrong file',
      };
    }
  }

  // W3 — the WORKFLOW side drifts. [NOT ok]
  {
    const r = gitCliffPinsAgree(
      W_CANONICAL_JUSTFILE,
      wNightly(W_INSTALL_FLOW(`git-cliff@${W_DRIFTED}`)),
    );
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          `TEETH W3: gitCliffPinsAgree accepted a workflow pinning git-cliff@${W_DRIFTED} while the ` +
          `justfile and GIT_CLIFF_PINNED_VERSION both say ${W_PIN} — the nightly job would then ` +
          'render a changelog nobody can reproduce locally',
      };
    }
  }

  // W4 — no live GIT_CLIFF_VERSION assignment anywhere. Fails LOUD: with zero
  // assignments there is nothing to compare, and "nothing to compare" must never
  // read as "they agree". [NOT ok]
  {
    const noAssign = wJustfile('# (no version pin here)', CHANGELOG_RECIPE_BODY);
    const r = gitCliffPinsAgree(noAssign, W_CANONICAL_NIGHTLY);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH W4: gitCliffPinsAgree accepted a justfile with NO live GIT_CLIFF_VERSION := ' +
          'assignment — an absent pin cannot be proven equal to anything and must fail loud, not ' +
          'fall through to ok',
      };
    }
  }

  // W5 — a COMMENTED decoy carrying the correct pin sits above the LIVE
  // assignment, which carries the wrong one. Kills a first-match indexOf scan:
  // the live value is the drifted one. [NOT ok]
  {
    const decoy = wJustfile(
      `# GIT_CLIFF_VERSION := "${W_PIN}"\nGIT_CLIFF_VERSION := "${W_DRIFTED}"`,
      CHANGELOG_RECIPE_BODY,
    );
    const r = gitCliffPinsAgree(decoy, W_CANONICAL_NIGHTLY);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          `TEETH W5: gitCliffPinsAgree accepted a justfile whose FIRST GIT_CLIFF_VERSION line is a ` +
          `# comment holding the correct ${W_PIN} while the LIVE assignment holds ${W_DRIFTED} — a ` +
          'first-match indexOf reads the comment; only live (non-comment) assignments count',
      };
    }
  }

  // W6 — TWO live assignments, BOTH holding the correct pin. Parse ambiguity
  // must fail LOUD even when every candidate would have passed: just is
  // last-wins, this scanner is first-wins, and a later edit to either line is
  // then invisible. "Some assignment matches" is not the rule; "exactly one
  // assignment, and it matches" is. [NOT ok]
  {
    const twoAssigns = wJustfile(
      `GIT_CLIFF_VERSION := "${W_PIN}"\nGIT_CLIFF_VERSION := "${W_PIN}"`,
      CHANGELOG_RECIPE_BODY,
    );
    const r = gitCliffPinsAgree(twoAssigns, W_CANONICAL_NIGHTLY);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH W6: gitCliffPinsAgree accepted TWO live GIT_CLIFF_VERSION := assignments (both ' +
          'holding the correct value) — the clause is "exactly one live assignment, and it ' +
          'matches", not "some assignment matches"; ambiguity the scanner cannot resolve must fail ' +
          'loud (the ADR-0200 D8 fail-closed discipline)',
      };
    }
  }

  // W7 — the workflow installs `tool: git-cliff` with NO @version at all, which
  // resolves to whatever upstream ships that night. [NOT ok]
  {
    const r = gitCliffPinsAgree(W_CANONICAL_JUSTFILE, wNightly(W_INSTALL_FLOW('git-cliff')));
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH W7: gitCliffPinsAgree accepted `with: { tool: git-cliff }` with no @version — an ' +
          'unpinned install resolves to whatever upstream ships that night, and one rendering ' +
          'change flips every entry to missing+extra at once',
      };
    }
  }

  // W8 — the only `git-cliff@<pin>` in the whole file lives in the COVERAGE
  // job; changelog-freshness installs nothing. Kills a whole-file indexOf: the
  // pin must be attributed to the job that actually uses it. [NOT ok]
  {
    const r = gitCliffPinsAgree(
      W_CANONICAL_JUSTFILE,
      wNightly('', W_INSTALL_FLOW(`git-cliff@${W_PIN}`)),
    );
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          `TEETH W8: gitCliffPinsAgree accepted a workflow whose only git-cliff@${W_PIN} install ` +
          'sits in the COVERAGE job while changelog-freshness installs nothing — the pin must be ' +
          'read through strictJobBlock + segmentJobBlock + withKeys for THIS job, never by an ' +
          'indexOf over the whole file',
      };
    }
  }

  // W9 — prefix collision in the version compare: the workflow pins
  // `git-cliff@<pin>0` (e.g. 2.13.10 against a 2.13.1 constant), a real and
  // shipping version number. Kills startsWith/indexOf on the version. [NOT ok]
  {
    const r = gitCliffPinsAgree(
      W_CANONICAL_JUSTFILE,
      wNightly(W_INSTALL_FLOW(`git-cliff@${W_PIN}0`)),
    );
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          `TEETH W9: gitCliffPinsAgree accepted git-cliff@${W_PIN}0 against ` +
          `GIT_CLIFF_PINNED_VERSION=${W_PIN} — a startsWith/indexOf version compare cannot tell ` +
          '2.13.10 from 2.13.1; the tool value must EQUAL git-cliff@<pin> exactly',
      };
    }
  }

  // W10 — FALSE-RED GUARD, the U5a lesson: nightly.yml writes this step in the
  // FLOW form (`with: { tool: … }`), which is house style, not an exotic shape.
  // Declared standalone rather than leaning on W1's builder so the flow-form
  // proof survives any later change to that builder. [ok]
  {
    const flowNightly = `name: Nightly
on:
  workflow_dispatch:
jobs:
  changelog-freshness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@abc1234abc1234abc1234abc1234abc1234abc12 # v6
        with: { fetch-depth: 0 }
      - uses: taiki-e/install-action@abc1234abc1234abc1234abc1234abc1234abc12 # v2
        with: { tool: git-cliff@${W_PIN} }
      - run: node scripts/changelog-freshness.mjs --check
`;
    const r = gitCliffPinsAgree(W_CANONICAL_JUSTFILE, flowNightly);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH W10: gitCliffPinsAgree rejected the house FLOW form \`with: { tool: git-cliff@${W_PIN} }\` — that is exactly how the committed nightly.yml writes it, so rejecting it false-REDs the real tree at Check 29. Reason: ${r.reason}`,
      };
    }
  }

  // W10b — the BLOCK form of the same step must read identically. A parser that
  // handles only the form the real file happens to use today silently stops
  // gating the day someone reformats it. [ok]
  {
    const r = gitCliffPinsAgree(
      W_CANONICAL_JUSTFILE,
      wNightly(W_INSTALL_BLOCK(`git-cliff@${W_PIN}`)),
    );
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH W10b: gitCliffPinsAgree rejected the BLOCK form (with: on its own line, tool: beneath it) of an identically-pinned install step — both with: forms are legal YAML and collectWithKeys already reads both. Reason: ${r.reason}`,
      };
    }
  }

  // W11 — FALSE-RED GUARD: the justfile pin quoted with single quotes. Valid
  // just; an assignment parser that hard-codes `"` REDs a legal file. [ok]
  {
    const r = gitCliffPinsAgree(
      wJustfile(`GIT_CLIFF_VERSION := '${W_PIN}'`, CHANGELOG_RECIPE_BODY),
      W_CANONICAL_NIGHTLY,
    );
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH W11: gitCliffPinsAgree rejected GIT_CLIFF_VERSION := '${W_PIN}' (single quotes) — both quote styles are valid just, and parseCapDefaultFromHeader already tolerates both for cap=. Reason: ${r.reason}`,
      };
    }
  }

  // W12 — FALSE-RED GUARD: no whitespace around `:=`. Also valid just. [ok]
  {
    const r = gitCliffPinsAgree(
      wJustfile(`GIT_CLIFF_VERSION:="${W_PIN}"`, CHANGELOG_RECIPE_BODY),
      W_CANONICAL_NIGHTLY,
    );
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `TEETH W12: gitCliffPinsAgree rejected \`GIT_CLIFF_VERSION:="${W_PIN}"\` with no spaces around := — that is valid just, and an assignment parser matching only the spaced spelling is a false RED waiting on a formatting change. Reason: ${r.reason}`,
      };
    }
  }

  // W13 — THE M4 CHEAT, proven by the red-team: the recipe still REFERENCES
  // {{GIT_CLIFF_VERSION}} and still prints the mismatch, but the fatal `exit 1`
  // becomes a non-fatal echo, so `just changelog` regenerates the ledger with
  // whatever git-cliff happens to be installed. Any "the recipe references the
  // variable" clause is satisfied by an echo; only equality with
  // CHANGELOG_RECIPE_BODY is not. Derived from the constant by a single
  // substitution, with an integrity guard so it can never become a no-op.
  // [NOT ok]
  {
    const W_EXIT_NEEDLE = '\n        exit 1\n';
    const softened = CHANGELOG_RECIPE_BODY.replace(
      W_EXIT_NEEDLE,
      '\n        echo "(continuing anyway)"\n',
    );
    if (softened === CHANGELOG_RECIPE_BODY) {
      return {
        name,
        pass: false,
        detail:
          'TEETH W13-integrity: the fixture substitution found no `exit 1` line to soften in ' +
          'CHANGELOG_RECIPE_BODY, so W13 would test the CANONICAL body and pass vacuously. Either ' +
          'the pinned recipe lost its fatal assertion (which is the bug W13 exists to catch) or ' +
          'the needle needs re-pinning alongside the constant',
      };
    }
    const r = gitCliffPinsAgree(
      wJustfile(W_LIVE_PIN_ASSIGN, softened),
      W_CANONICAL_NIGHTLY,
    );
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH W13: gitCliffPinsAgree accepted a changelog: recipe whose version assertion prints ' +
          '"(continuing anyway)" instead of exiting 1 — the recipe still MENTIONS ' +
          '{{GIT_CLIFF_VERSION}}, so every "references the variable" clause passes while the ' +
          'guard is dead; the body must EQUAL CHANGELOG_RECIPE_BODY',
      };
    }
  }

  // W14 — asserts one binary, RUNS another: the version check passes against
  // `git cliff` on PATH and the generation step invokes
  // `~/.cargo/bin/git-cliff`, which may be any version at all. Assert on the
  // MUTATING call, never on the binding (the recorded
  // abort-construct-blacklist lesson). [NOT ok]
  {
    const W_INVOKE_NEEDLE = '\n    git cliff -o CHANGELOG.md';
    const wrongBinary = CHANGELOG_RECIPE_BODY.replace(
      W_INVOKE_NEEDLE,
      '\n    ~/.cargo/bin/git-cliff -o CHANGELOG.md',
    );
    if (wrongBinary === CHANGELOG_RECIPE_BODY) {
      return {
        name,
        pass: false,
        detail:
          'TEETH W14-integrity: the fixture substitution found no `git cliff -o CHANGELOG.md` line ' +
          'in CHANGELOG_RECIPE_BODY, so W14 would test the CANONICAL body and pass vacuously — ' +
          're-pin the needle alongside the constant',
      };
    }
    const r = gitCliffPinsAgree(
      wJustfile(W_LIVE_PIN_ASSIGN, wrongBinary),
      W_CANONICAL_NIGHTLY,
    );
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH W14: gitCliffPinsAgree accepted a recipe that asserts the version of `git cliff` ' +
          'on PATH and then generates the changelog with `~/.cargo/bin/git-cliff` — asserting one ' +
          'binary and mutating with another is the classic bypass; the pin must cover the ' +
          'MUTATING call',
      };
    }
  }

  // W15 — TWO live install steps in changelog-freshness: the first correctly
  // pinned, the second unpinned. The later install OVERWRITES the binary, so
  // the job runs `latest` — while an extractor that stops at the first match
  // still finds the pinned one and reports agreement. [NOT ok]
  {
    const twoInstalls = wNightly(
      `${W_INSTALL_FLOW(`git-cliff@${W_PIN}`)}${W_INSTALL_FLOW('git-cliff')}`,
    );
    const r = gitCliffPinsAgree(W_CANONICAL_JUSTFILE, twoInstalls);
    if (r.ok) {
      return {
        name,
        pass: false,
        detail:
          'TEETH W15: gitCliffPinsAgree accepted TWO live git-cliff install steps in ' +
          'changelog-freshness, the second unpinned — the later install overwrites the binary so ' +
          'the job runs latest, while a first-match extractor still finds the pinned one. Clause ' +
          '(b) is EXACTLY ONE live git-cliff install step',
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
  // Decision-hook mdrewt/claude-harness#14 was ANSWERED in lp-03: the `notify` job
  // added by ADR-0200 (Checks 21–23 below) now opens a GitHub issue per non-success
  // job. That does not retire these three checks — the issue names the failing job,
  // the preamble records the triage ROUTING (ADR-0050) — so the preamble stays.

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

  // =========================================================================
  // 16r-c REAL FILE CHECKS (ADR-0196 — the changelog-freshness gate)
  // The ORDER is a DIAGNOSIS order, not an arbitrary one: structure → workflow
  // scope → presence → neuter → policy → pins. Each step narrows what a red can
  // mean, and each earlier check is a precondition for the next being readable
  // at all — asking "is this job neutered?" of a file with two `jobs:` mappings
  // is asking about a block that may never run.
  //   Check 24 nightlyJobStructureIsUnambiguous → GREEN today (one jobs: mapping,
  //            no duplicate job keys) — a regression ratchet, not new work
  //   Check 25 nightlyHasNoWorkflowScopeNeuters → GREEN today (no top-level
  //            defaults:; the top-level env: holds only
  //            FORCE_JAVASCRIPT_ACTIONS_TO_NODE24)
  //   Check 26 nightlyDeclaresJob('changelog-freshness') → GREEN today
  //   Check 27 jobIsNotNeutered(…, { gates: CHANGELOG_FRESHNESS_GATES }) → GREEN
  //            today; this is where a pin that does not match the committed job
  //            body would surface as a FALSE red, which is why TEETH V1 renders
  //            its positive control from the same constant
  //   Check 28 jobHasFailurePolicyComment('changelog-freshness') → GREEN today
  //            (the preamble at .github/workflows/nightly.yml:180-181)
  //   Check 29 gitCliffPinsAgree → THE SOLE GENUINELY-EXPECTED RED: the justfile
  //            declares no GIT_CLIFF_VERSION at all and its `changelog:` recipe
  //            is the single unguarded line `git cliff -o CHANGELOG.md`, while
  //            nightly.yml already pins git-cliff@2.13.1
  // =========================================================================

  // Check 24: exactly one top-level jobs: mapping, no job key declared twice.
  // GREEN today. It is a fail-closed precondition for Checks 26-28: YAML is
  // last-wins on a duplicate key and every text scanner in this file is
  // first-wins, so a second `if: false` copy of any job would let the checks
  // below inspect a definition GitHub never runs.
  {
    const r = nightlyJobStructureIsUnambiguous(nightlyYml);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `nightly.yml job structure is ambiguous, so every job-scoped check below may be reading a definition that never runs: ${r.reason}`,
      };
    }
  }

  // Check 25: no workflow-SCOPE neuter. GREEN today. A top-level `defaults: run:
  // shell:` no-ops every run step in every job, and a top-level `env: PATH:`
  // shims the toolchain for all five gates at once; both are invisible to every
  // job-scoped predicate in this file, including the gate-step shell rule.
  {
    const r = nightlyHasNoWorkflowScopeNeuters(nightlyYml);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `nightly.yml carries a workflow-scope neuter that silently disables every job at once: ${r.reason}`,
      };
    }
  }

  // Check 26: the changelog-freshness job is DECLARED. GREEN today. Deleting the
  // job (and dropping it from notify's needs:) is invisible to every other
  // predicate here — nightlyNotifyIsWired derives its required set FROM the
  // file, so a deleted job leaves the fan-in internally consistent.
  {
    const r = nightlyDeclaresJob(nightlyYml, 'changelog-freshness');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `nightly.yml no longer declares the changelog-freshness job (ADR-0196): ${r.reason}`,
      };
    }
  }

  // Check 27: the changelog-freshness job is not neutered AND its two gate steps
  // match CHANGELOG_FRESHNESS_GATES verbatim, in order. GREEN today. This is the
  // check TEETH V1's round trip protects: a pin that cannot accept its own
  // rendering would false-RED here on a perfectly healthy workflow.
  {
    const r = jobIsNotNeutered(nightlyYml, 'changelog-freshness', {
      gates: CHANGELOG_FRESHNESS_GATES,
    });
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `changelog-freshness job is neutered or its gate steps have drifted from CHANGELOG_FRESHNESS_GATES in nightly.yml: ${r.reason}`,
      };
    }
  }

  // Check 28: the changelog-freshness job documents its failure policy in the
  // contiguous 2-space comment preamble above its job key, exactly as the other
  // four guarded jobs do (Checks 14-16). GREEN today — the preamble already
  // exists at .github/workflows/nightly.yml:180-181; this is a ratchet against
  // REMOVING it, not a demand for new work. The notify job says WHICH job
  // failed; the preamble says WHAT HAPPENS NEXT.
  {
    const r = jobHasFailurePolicyComment(nightlyYml, 'changelog-freshness');
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `nightly.yml job 'changelog-freshness' has no documented failure policy above its job key: ${r.reason}`,
      };
    }
  }

  // Check 29: the git-cliff pin agrees across the justfile and the workflow, and
  // the `changelog:` recipe body is intact (EXPECTED RED — the sole one this
  // slice adds).
  // GREEN edit: add `GIT_CLIFF_VERSION := "<GIT_CLIFF_PINNED_VERSION>"` to the
  // justfile and replace the one-line `changelog:` recipe with the version-
  // asserting shebang recipe pinned by CHANGELOG_RECIPE_BODY (plus the sibling
  // `changelog-check:` recipe). Both sides then generate the SAME CHANGELOG.md
  // the freshness checker diffs against; today a local `just changelog` run with
  // any other git-cliff rewrites every entry and the nightly gate reds for a
  // reason that has nothing to do with ledger freshness.
  {
    const r = gitCliffPinsAgree(justfile, nightlyYml);
    if (!r.ok) {
      return {
        name,
        pass: false,
        detail: `the git-cliff pin does not agree between the justfile and nightly.yml (EXPECTED RED): ${r.reason}`,
      };
    }
  }

  return {
    name,
    pass: true,
    detail:
      'nightly smoke-republish correctly wired: job exists in nightly.yml (not ci.yml), references smoke-republish.sh, justfile recipe present, script committed, ADR-0079 documents the failure policy; m13.5a additions: mutation/coverage/mutation-server jobs present and unneutered, schedule+dispatch triggers live, coverage threshold ≥96, mutate-server recipe intact; 14r-a additions: all three guarded jobs document an attributed failure policy in their comment preamble, and the justfile mutate-server cap= default equals MUTATE_SERVER_CAP_BASELINE; lp-03 additions (ADR-0200): both mutation jobs upload mutants.out/ with if: always(), under distinct artifact names, and the notify job fans in over every other job, admits failure/skipped/cancelled, holds an effective issues: write grant that no other job holds, and opens exactly one attributed issue per non-success job; 16r-c additions (ADR-0196): nightly.yml has exactly one jobs: mapping with no duplicate job keys and no workflow-scope neuter (no top-level defaults:, no PATH key in the top-level env:), and the changelog-freshness job is declared, documents an attributed failure policy, and runs its two gate steps — the TAP gating suite and `node scripts/changelog-freshness.mjs --check` — verbatim and in order per CHANGELOG_FRESHNESS_GATES, with the justfile GIT_CLIFF_VERSION, the workflow git-cliff@<version> install pin and the pinned `changelog:` recipe body all in agreement',
  };
}
