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

  return {
    name,
    pass: true,
    detail: 'desync assertion bites on a known-bad fixture; e2e gate wired in CI',
  };
}
