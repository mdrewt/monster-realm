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
// `pull_request`). The detection functions are exported as stubs that throw so this
// eval is RED until the specialist implements them.
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

// --- M8.8f structural gate stubs (specialist implements; bodies throw → RED) ---

// True iff the workflow's top-level `on:` fires on `pull_request`.
export function triggersOnPullRequest(yaml) {
  const lines = yaml.split('\n');
  let inOn = false;
  for (const line of lines) {
    // A top-level key sits at 0 indent (no leading space) and ends with `:`.
    const isTopLevelKey = /^\S.*:/.test(line);
    if (inOn) {
      // Leaving the `on:` block at the next 0-indent key (e.g. jobs:/permissions:).
      if (isTopLevelKey && !/^on\b/.test(line)) {
        inOn = false;
      } else if (/pull_request/.test(line)) {
        return true;
      }
    }
    if (/^on:/.test(line)) {
      inOn = true;
      // Inline forms: `on: pull_request` or `on: [push, pull_request]`.
      if (/pull_request/.test(line)) {
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
//   (3) the e2e job block has NO job-level `continue-on-error: true`
//   (4) the e2e job block has NO job-level `if:`
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
  // Job-level keys sit at exactly 4 spaces; step-level keys sit at >=6 spaces.
  for (const line of block.split('\n')) {
    if (/^ {4}continue-on-error:\s*true\b/.test(line)) {
      return {
        ok: false,
        reason: 'e2e job has job-level continue-on-error: true (failures non-blocking)',
      };
    }
    if (/^ {4}if:/.test(line)) {
      return {
        ok: false,
        reason: 'e2e job has a job-level if: condition (can disable the gate, e.g. if: false)',
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
  // These exercise e2eGateIsBlocking via known inline YAML fixtures. Because the
  // detection functions are stubs, ALL of these assertions will throw — the eval
  // returns RED. The specialist's job is to implement the three detection fns so
  // the suite turns GREEN without changing any of the expected values below.

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

  // Run all structural fixture assertions. Because the stubs throw, the first one
  // will short-circuit with an error, making the eval RED.
  const structuralCases = [
    { label: 'goodWf', wf: goodWf, expectedOk: true },
    { label: 'disabledByIf', wf: disabledByIf, expectedOk: false },
    { label: 'disabledByContinue', wf: disabledByContinue, expectedOk: false },
    { label: 'notPrTriggered', wf: notPrTriggered, expectedOk: false },
    { label: 'e2eRemoved', wf: e2eRemoved, expectedOk: false },
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
      'desync assertion bites on a known-bad fixture; e2e gate wired in CI; structural gate fixtures all pass; real ci.yml is blocking',
  };
}
