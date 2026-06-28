// Proof-of-teeth for the M5b two-window e2e desync gate (ADR-0009 / ADR-0010).
//
// The REAL gate is the `e2e` CI job: a version-pinned standalone SpacetimeDB +
// Playwright driving two browser windows through the golden flows (client/e2e/
// golden.spec.ts), asserting on the `window.__game()` state snapshot. That job is
// slow and heavy. This eval makes the gate FALSIFIABLE cheaply on every CI run, per
// ADR-0010 ("every mechanical gate ships a known-bad fixture it must reject"):
//   (1) the canonical no-desync invariant (predicted == authoritative — the
//       "single most valuable assertion", the wall-bump net) actually REJECTS a
//       desynced snapshot fixture; and
//   (2) the e2e gate is still WIRED into ci.yml (a silently removed/disabled job is
//       caught — ADR-0010's "accidentally disabled/weakened gate" failure mode).
//
// M8.8f additions: structural gate that detects a NEUTERED e2e job (disabled via
// `if: false`, `continue-on-error: true`, or a workflow that no longer fires on
// `pull_request`). Round-2 teeth (added after specialist implemented the detectors)
// cover additional bypass vectors found by red-team/reviewer: step-level if/continue,
// expression-form continue-on-error, YAML boolean alias `yes`, pull_request_target
// false-positive, commented-out trigger, and a shell-if positive control.
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Pure: the exact invariant golden.spec.ts asserts after a wall bump — the acting
// window's predicted tile equals its authoritative tile (no client/server desync).
export function noDesync(snap) {
  const a = snap.ownAuthTile;
  const p = snap.ownPredictedTile;
  if (!a || !p) return false;
  return a.x === p.x && a.y === p.y;
}

// Pure: does the CI workflow still wire the e2e gate? A job keyed `e2e:` that runs
// the two-window flow (just e2e / playwright / npm run e2e) against a `spacetime`.
export function ciWiresE2eGate(yaml) {
  const hasJob = /\n\s{2,}e2e:\s*\n/.test(yaml);
  const runsE2e = /just\s+e2e|playwright\s+test|npm\s+run\s+e2e/.test(yaml);
  const usesSpacetime = /spacetime/.test(yaml);
  return hasJob && runsE2e && usesSpacetime;
}

// --- M8.8f structural gate (detectors implemented; round-2-hardened) ---
//
// KNOWN OUT-OF-SCOPE residuals this gate does NOT catch (documented, deferred):
//   - a `needs:`-chain on a disabled prerequisite job (the e2e gate is skipped
//     when a needed job is itself disabled/skipped);
//   - an empty `strategy.matrix` (zero matrix entries → zero job runs);
//   - a `just e2e` string present only in a step `name:` while the `run:` is a no-op;
//   - a custom proc-macro alias instead of `#[spacetimedb::reducer]`.

// True iff the workflow's top-level `on:` fires on `pull_request`.
export function triggersOnPullRequest(yaml) {
  const lines = yaml.split('\n');
  let inOn = false;
  for (const line of lines) {
    // YAML comment lines never activate a trigger (a commented-out trigger
    // is not live). `\bpull_request\b` deliberately rejects pull_request_target
    // (the `_` after `request` is a word char, so the boundary does not match).
    const isComment = line.trim().startsWith('#');
    const hasPrTrigger = !isComment && /\bpull_request\b/.test(line);
    // A top-level key sits at 0 indent (no leading space) and ends with `:`.
    const isTopLevelKey = /^\S.*:/.test(line);
    if (inOn) {
      // Leaving the `on:` block at the next 0-indent key (e.g. jobs:/permissions:).
      if (isTopLevelKey && !/^on\b/.test(line)) {
        inOn = false;
      } else if (hasPrTrigger) {
        return true;
      }
    }
    if (/^on:/.test(line)) {
      inOn = true;
      // Inline forms: `on: pull_request` or `on: [push, pull_request]`.
      if (hasPrTrigger) {
        return true;
      }
    }
  }
  return false;
}

// Returns the text of the named job's block (lines under `  <jobName>:` at deeper
// indent, up to the next 2-space-indented job key or EOF), or '' if absent.
export function extractJobBlock(yaml, jobName) {
  const lines = yaml.split('\n');
  const keyLine = `  ${jobName}:`;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === keyLine || lines[i].startsWith(`${keyLine} `)) {
      start = i;
      break;
    }
  }
  if (start === -1) return '';
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // Blank lines belong to the block (they may sit between steps).
    if (line.trim() === '') {
      block.push(line);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    // A 0-indent line or a next 2-space-indented job key ends the block.
    if (indent === 0) break;
    if (indent === 2) break;
    block.push(line);
  }
  return `${block.join('\n')}\n`;
}

// Returns { ok: boolean, reason: string }.
// ok is true ONLY when:
//   (1) triggersOnPullRequest is true
//   (2) the e2e job exists and is "wired" (ciWiresE2eGate)
//   (3) the e2e job block has NO `continue-on-error:` with a truthy value (job OR step)
//   (4) the e2e job block has NO `if:` key (job OR step)
// On any failure, reason names which condition failed.
export function e2eGateIsBlocking(yaml) {
  if (!triggersOnPullRequest(yaml)) {
    return {
      ok: false,
      reason: 'workflow does not trigger on pull_request (e2e gate not PR-blocking)',
    };
  }
  if (!ciWiresE2eGate(yaml)) {
    return {
      ok: false,
      reason: 'e2e job missing or not running the two-window flow vs spacetime',
    };
  }
  const block = extractJobBlock(yaml, 'e2e');
  // Match a YAML key at ANY indent (job or step) via the trimmed line. A shell
  // `if curl ...; then` inside a `run: |` block trims to `if curl...`, not `if:`,
  // so it is NOT mistaken for a YAML `if:` key.
  for (const line of block.split('\n')) {
    const tr = line.trim();
    if (tr.startsWith('continue-on-error:')) {
      const value = tr.slice('continue-on-error:'.length).trim();
      // Truthy YAML booleans/aliases or an expression that evaluates to true.
      if (/^(true|yes|on|True)\b/.test(value) || /\$\{\{\s*true\s*\}\}/.test(value)) {
        return {
          ok: false,
          reason: 'e2e job/step has a truthy continue-on-error (failures non-blocking)',
        };
      }
    }
    if (tr.startsWith('if:')) {
      return {
        ok: false,
        reason: 'e2e job/step has an if: condition (can disable the gate)',
      };
    }
  }
  return { ok: true, reason: 'e2e gate is PR-blocking, wired, and not neutered' };
}

export default async function () {
  const name = 'e2e-desync-teeth (bump => predicted==auth gate is falsifiable + wired)';

  // Proof-of-teeth #1: a DESYNCED snapshot MUST be rejected; a synced one accepted.
  const desynced = { ownAuthTile: { x: 4, y: 7 }, ownPredictedTile: { x: 5, y: 7 } };
  const synced = { ownAuthTile: { x: 4, y: 7 }, ownPredictedTile: { x: 4, y: 7 } };
  if (noDesync(desynced)) {
    return {
      name,
      pass: false,
      detail: 'proof-of-teeth: noDesync failed to reject a desynced snapshot',
    };
  }
  if (!noDesync(synced)) {
    return {
      name,
      pass: false,
      detail: 'proof-of-teeth: noDesync wrongly rejected a synced snapshot',
    };
  }

  // Proof-of-teeth #2: the e2e gate must stay wired in CI (a disabled gate is caught).
  const ciPath = path.resolve('.github/workflows/ci.yml');
  let yaml = '';
  try {
    yaml = readFileSync(ciPath, 'utf8');
  } catch {
    return { name, pass: false, detail: `cannot read ${ciPath}` };
  }
  if (!ciWiresE2eGate(yaml)) {
    return {
      name,
      pass: false,
      detail:
        'e2e gate not wired in ci.yml (need a job `e2e:` running the two-window flow vs spacetime)',
    };
  }

  // --- M8.8f proof-of-teeth #3: structural gate fixtures ---
  // These exercise e2eGateIsBlocking via known inline YAML fixtures. The round-2
  // bypass fixtures are RED against the current detector; the specialist strengthens
  // the detectors so they turn GREEN without changing any expected values below.

  // A minimal HEALTHY workflow: pull_request trigger, a ci: job, a wired e2e: job.
  // Job-level keys at 4-space indent; step items at 6+ spaces.
  const goodWf = `name: CI
on:
  push:
    branches: [master]
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Start spacetime
        run: nohup spacetime start --in-memory &
      - name: Two-window e2e
        env:
          VITE_STDB_URI: ws://127.0.0.1:3000
        run: just e2e
`;

  // goodWf but e2e job has job-level `if: false`.
  const disabledByIf = `name: CI
on:
  push:
    branches: [master]
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  e2e:
    runs-on: ubuntu-latest
    if: false
    steps:
      - uses: actions/checkout@v4
      - name: Start spacetime
        run: nohup spacetime start --in-memory &
      - name: Two-window e2e
        env:
          VITE_STDB_URI: ws://127.0.0.1:3000
        run: just e2e
`;

  // goodWf but e2e job has job-level `continue-on-error: true`.
  const disabledByContinue = `name: CI
on:
  push:
    branches: [master]
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  e2e:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
      - name: Start spacetime
        run: nohup spacetime start --in-memory &
      - name: Two-window e2e
        env:
          VITE_STDB_URI: ws://127.0.0.1:3000
        run: just e2e
`;

  // goodWf but on: only has push: (no pull_request).
  const notPrTriggered = `name: CI
on:
  push:
    branches: [master]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Start spacetime
        run: nohup spacetime start --in-memory &
      - name: Two-window e2e
        env:
          VITE_STDB_URI: ws://127.0.0.1:3000
        run: just e2e
`;

  // Workflow with only a ci: job — no e2e: at all.
  const e2eRemoved = `name: CI
on:
  push:
    branches: [master]
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;

  // --- M8.8f round-2 bypass fixtures (new teeth from red-team/reviewer) ---

  // E2: a step inside the e2e job carries `if: false` at step level (8-space indent).
  // Kills: an impl that only checks 4-space (job-level) `if:` and misses step-level disable.
  const stepLevelIf = `name: CI
on:
  push:
    branches: [master]
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Start spacetime
        run: nohup spacetime start --in-memory &
      - name: Two-window e2e
        if: false
        env:
          VITE_STDB_URI: ws://127.0.0.1:3000
        run: just e2e
`;

  // E5: a step inside the e2e job carries `continue-on-error: true` at step level.
  // Kills: an impl that only checks job-level continue-on-error and misses step-level.
  const stepLevelContinue = `name: CI
on:
  push:
    branches: [master]
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Start spacetime
        run: nohup spacetime start --in-memory &
      - name: Two-window e2e
        continue-on-error: true
        env:
          VITE_STDB_URI: ws://127.0.0.1:3000
        run: just e2e
`;

  // E3a: job-level `continue-on-error: ${{ true }}` (expression form).
  // Kills: an impl whose regex matches only the literal word `true` and misses expressions.
  const continueExprTrue = `name: CI
on:
  push:
    branches: [master]
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  e2e:
    runs-on: ubuntu-latest
    continue-on-error: \${{ true }}
    steps:
      - uses: actions/checkout@v4
      - name: Start spacetime
        run: nohup spacetime start --in-memory &
      - name: Two-window e2e
        env:
          VITE_STDB_URI: ws://127.0.0.1:3000
        run: just e2e
`;

  // E3b: job-level `continue-on-error: yes` (YAML boolean alias).
  // Kills: an impl that only matches `true` and misses the `yes` alias.
  const continueYes = `name: CI
on:
  push:
    branches: [master]
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  e2e:
    runs-on: ubuntu-latest
    continue-on-error: yes
    steps:
      - uses: actions/checkout@v4
      - name: Start spacetime
        run: nohup spacetime start --in-memory &
      - name: Two-window e2e
        env:
          VITE_STDB_URI: ws://127.0.0.1:3000
        run: just e2e
`;

  // E4: `on:` has ONLY `pull_request_target:` — a different trigger that does not
  // run on the PR diff in untrusted contexts and is not a PR-blocking gate.
  // Kills: an impl whose pull_request check matches any string containing `pull_request`
  // (a substring match would wrongly accept `pull_request_target`).
  const prTargetOnly = `name: CI
on:
  push:
    branches: [master]
  pull_request_target:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Start spacetime
        run: nohup spacetime start --in-memory &
      - name: Two-window e2e
        env:
          VITE_STDB_URI: ws://127.0.0.1:3000
        run: just e2e
`;

  // H2: `pull_request:` appears only in a YAML comment — trigger not active.
  // Kills: an impl that scans raw text for the string `pull_request` without
  // distinguishing comment lines from active YAML keys.
  const commentedPrTrigger = `name: CI
on:
  push:
    branches: [master]
  # pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Start spacetime
        run: nohup spacetime start --in-memory &
      - name: Two-window e2e
        env:
          VITE_STDB_URI: ws://127.0.0.1:3000
        run: just e2e
`;

  // POSITIVE CONTROL: healthy e2e job whose Wait step has a shell `if` inside `run: |`.
  // The shell `if curl ...; then echo ok; fi` lives inside a multi-line run block and
  // MUST NOT be mistaken for a YAML job/step-level `if:` key.
  // expectedOk: TRUE — kills an impl that over-reaches and flags shell `if` inside run blocks.
  const goodWfShellIf = `name: CI
on:
  push:
    branches: [master]
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Start spacetime
        run: nohup spacetime start --in-memory &
      - name: Wait for SpacetimeDB
        run: |
          for i in $(seq 1 60); do
            if curl -s -o /dev/null http://127.0.0.1:3000/; then
              echo "ready after \${i}s"; exit 0
            fi
            sleep 1
          done
          echo "spacetime did not become ready" >&2; exit 1
      - name: Two-window e2e
        env:
          VITE_STDB_URI: ws://127.0.0.1:3000
        run: just e2e
`;

  // Run all structural fixture assertions. The new round-2 teeth (stepLevelIf,
  // stepLevelContinue, continueExprTrue, continueYes, prTargetOnly,
  // commentedPrTrigger) are expected RED against the current detector; the
  // specialist must fix the detectors to make them GREEN.
  // goodWfShellIf is a positive control that must stay GREEN (no over-reach).
  const structuralCases = [
    { label: 'goodWf', wf: goodWf, expectedOk: true },
    { label: 'disabledByIf', wf: disabledByIf, expectedOk: false },
    { label: 'disabledByContinue', wf: disabledByContinue, expectedOk: false },
    { label: 'notPrTriggered', wf: notPrTriggered, expectedOk: false },
    { label: 'e2eRemoved', wf: e2eRemoved, expectedOk: false },
    // Round-2 bypass teeth:
    { label: 'stepLevelIf', wf: stepLevelIf, expectedOk: false },
    { label: 'stepLevelContinue', wf: stepLevelContinue, expectedOk: false },
    { label: 'continueExprTrue', wf: continueExprTrue, expectedOk: false },
    { label: 'continueYes', wf: continueYes, expectedOk: false },
    { label: 'prTargetOnly', wf: prTargetOnly, expectedOk: false },
    { label: 'commentedPrTrigger', wf: commentedPrTrigger, expectedOk: false },
    { label: 'goodWfShellIf', wf: goodWfShellIf, expectedOk: true },
  ];

  for (const { label, wf, expectedOk } of structuralCases) {
    let result;
    try {
      result = e2eGateIsBlocking(wf);
    } catch (err) {
      return {
        name,
        pass: false,
        detail: `structural gate fixture '${label}': e2eGateIsBlocking threw — ${err.message}`,
      };
    }
    if (typeof result !== 'object' || result === null || typeof result.ok !== 'boolean') {
      return {
        name,
        pass: false,
        detail: `structural gate fixture '${label}': e2eGateIsBlocking must return { ok: boolean, reason: string }, got ${JSON.stringify(result)}`,
      };
    }
    if (result.ok !== expectedOk) {
      return {
        name,
        pass: false,
        detail: `structural gate fixture '${label}': expected ok=${expectedOk} but got ok=${result.ok} — reason: ${result.reason}`,
      };
    }
  }

  // Final: assert the REAL ci.yml is blocking.
  let realResult;
  try {
    realResult = e2eGateIsBlocking(yaml);
  } catch (err) {
    return {
      name,
      pass: false,
      detail: `real ci.yml: e2eGateIsBlocking threw — ${err.message}`,
    };
  }
  if (!realResult.ok) {
    return {
      name,
      pass: false,
      detail: `real ci.yml: e2eGateIsBlocking reports NOT blocking — ${realResult.reason}`,
    };
  }

  return {
    name,
    pass: true,
    detail:
      'desync assertion bites on a known-bad fixture; e2e gate wired in CI; all structural gate fixtures pass (incl. round-2: step-level if/continue, expr continue, yes alias, pr_target, commented trigger, shell-if positive control); real ci.yml is blocking',
  };
}
