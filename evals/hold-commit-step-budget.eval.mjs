// hold-commit-step-budget.eval.mjs — slice `movement-investigation` (ADR-0158)
//
// ONE architecture gate binding the client's hold-commit threshold to the game-core
// cadence SSOT. `HOLD_COMMIT_MS` (client/src/prediction/heldKeys.ts) is only safe
// while the walk-start budget holds against the REAL tick cadence:
//
//     HOLD_COMMIT_MS + framePeriod(30fps) + latencyMargin(1ms) < STEP_MS
//
// (After the ungated first step drains, the step-2 continuation must reach the server
// before the next `movement_tick` or the server goes Idle for a slot — a visible
// walk-start stutter, the ADR-0013 defect class nh2/ADR-0148 exists to prevent.)
//
// WHY AN EVAL AND NOT A UNIT TEST: the client suite is node-only and reads no Rust, so
// heldKeys.test.ts U-H8 pins the SAME arithmetic against a LITERAL 200. If game-core
// ever retunes `STEP_MS` (game-core/src/world.rs), the predictor/store/resolver all
// adapt via the wasm `step_ms()` export, U-H8 stays green against its stale literal,
// and the walk-start budget silently breaks. This eval re-derives the inequality from
// the Rust source itself (the SSOT, per client/src/render/config.ts's "STEP_MS is NOT
// duplicated here" discipline), so a cadence retune reds CI until HOLD_COMMIT_MS is
// re-derived (desync-guard finding, movement-investigation review).
//
// House style (dev-observability-gating.eval.mjs): NO dynamic RegExp anywhere (Semgrep
// detect-non-literal-regexp has bitten master); literal indexOf/slice parsing only;
// pure exported predicates with GOOD + BAD fixtures run UNCONDITIONALLY before any
// real-source scan — a broken predicate must never gate production code.

import { readFileSync } from 'node:fs';

const WORLD_RS_PATH = 'game-core/src/world.rs';
const HELD_KEYS_PATH = 'client/src/prediction/heldKeys.ts';
const STEP_NEEDLE = 'pub const STEP_MS: i64 = ';
const HOLD_NEEDLE = 'export const HOLD_COMMIT_MS = ';
// The two budget terms, mirrored from heldKeys.test.ts U-H8 / ADR-0158: the worst
// supported frame wait (30fps floor, ADR-0148 contract) plus the local-playtest
// one-way latency margin (ADR-0129 deployment model).
const FRAME_PERIOD_30FPS_MS = 1000 / 30;
const LATENCY_MARGIN_MS = 1;

/**
 * Parse the integer literal that immediately follows `needle` in `src`.
 * Literal scan only (no regex). Returns null when the needle is missing or what
 * follows is not a bare non-negative integer terminated by `;` (whitespace allowed).
 * @param {string} src
 * @param {string} needle
 * @returns {number | null}
 */
export function parseConstInt(src, needle) {
  const at = src.indexOf(needle);
  if (at === -1) return null;
  // A second occurrence is ambiguous — refuse to guess which one is the SSOT.
  if (src.indexOf(needle, at + needle.length) !== -1) return null;
  const rest = src.slice(at + needle.length);
  const semi = rest.indexOf(';');
  if (semi === -1) return null;
  const token = rest.slice(0, semi).trim();
  if (token.length === 0 || token.length > 9) return null;
  for (const ch of token) {
    if (ch < '0' || ch > '9') return null;
  }
  return Number(token);
}

/**
 * The walk-start budget inequality (returns a failure string or null when it holds).
 * @param {number} holdCommitMs
 * @param {number} stepMs
 * @returns {string | null}
 */
export function checkWalkStartBudget(holdCommitMs, stepMs) {
  const worstEmissionMs = holdCommitMs + FRAME_PERIOD_30FPS_MS + LATENCY_MARGIN_MS;
  if (worstEmissionMs < stepMs) return null;
  return (
    `HOLD_COMMIT_MS=${holdCommitMs} breaks the walk-start budget: ` +
    `${holdCommitMs} + ${FRAME_PERIOD_30FPS_MS.toFixed(2)} (30fps frame) + ` +
    `${LATENCY_MARGIN_MS} (latency) = ${worstEmissionMs.toFixed(2)} >= STEP_MS=${stepMs} — ` +
    'the step-2 continuation can miss its tick slot and the server goes Idle ' +
    '(visible walk-start stutter). Re-derive the threshold per ADR-0158.'
  );
}

export default async function evaluate() {
  const name = 'hold-commit-step-budget';

  // --- fixture teeth: every predicate proves it bites BEFORE gating real source ---
  const fixtureFailures = [];
  if (parseConstInt('pub const STEP_MS: i64 = 200;', STEP_NEEDLE) !== 200) {
    fixtureFailures.push('parseConstInt GOOD fixture (200) failed');
  }
  if (parseConstInt('export const HOLD_COMMIT_MS = 150;', HOLD_NEEDLE) !== 150) {
    fixtureFailures.push('parseConstInt GOOD fixture (150) failed');
  }
  if (parseConstInt('no needle here;', STEP_NEEDLE) !== null) {
    fixtureFailures.push('parseConstInt BAD fixture (missing needle) not rejected');
  }
  if (parseConstInt('pub const STEP_MS: i64 = 12a;', STEP_NEEDLE) !== null) {
    fixtureFailures.push('parseConstInt BAD fixture (non-integer) not rejected');
  }
  if (
    parseConstInt('pub const STEP_MS: i64 = 200;\npub const STEP_MS: i64 = 100;', STEP_NEEDLE) !==
    null
  ) {
    fixtureFailures.push('parseConstInt BAD fixture (duplicate needle) not rejected');
  }
  if (checkWalkStartBudget(150, 200) !== null) {
    fixtureFailures.push('checkWalkStartBudget GOOD fixture (150 vs 200) flagged');
  }
  if (checkWalkStartBudget(175, 200) === null) {
    fixtureFailures.push('checkWalkStartBudget BAD fixture (175 vs 200) not flagged');
  }
  if (checkWalkStartBudget(150, 120) === null) {
    fixtureFailures.push('checkWalkStartBudget BAD fixture (STEP_MS retuned to 120) not flagged');
  }
  if (fixtureFailures.length > 0) {
    return {
      name,
      pass: false,
      detail: `predicate fixtures broken (eval cannot be trusted): ${fixtureFailures.join('; ')}`,
    };
  }

  // --- real-source scan -----------------------------------------------------------
  let worldSrc;
  let heldSrc;
  try {
    worldSrc = readFileSync(WORLD_RS_PATH, 'utf8');
  } catch {
    return { name, pass: false, detail: `cannot read ${WORLD_RS_PATH}` };
  }
  try {
    heldSrc = readFileSync(HELD_KEYS_PATH, 'utf8');
  } catch {
    return { name, pass: false, detail: `cannot read ${HELD_KEYS_PATH}` };
  }

  const stepMs = parseConstInt(worldSrc, STEP_NEEDLE);
  if (stepMs === null) {
    return {
      name,
      pass: false,
      detail:
        `${WORLD_RS_PATH}: could not parse a unique \`${STEP_NEEDLE}<int>;\` — the cadence ` +
        'SSOT moved or changed shape; update this eval alongside it.',
    };
  }
  const holdCommitMs = parseConstInt(heldSrc, HOLD_NEEDLE);
  if (holdCommitMs === null) {
    return {
      name,
      pass: false,
      detail:
        `${HELD_KEYS_PATH}: could not parse a unique \`${HOLD_NEEDLE}<int>;\` — the ` +
        'hold-commit threshold moved or changed shape; update this eval alongside it.',
    };
  }

  const budgetFailure = checkWalkStartBudget(holdCommitMs, stepMs);
  if (budgetFailure !== null) {
    return { name, pass: false, detail: budgetFailure };
  }

  return {
    name,
    pass: true,
    detail:
      `HOLD_COMMIT_MS=${holdCommitMs} (${HELD_KEYS_PATH}) fits the walk-start budget ` +
      `against the REAL STEP_MS=${stepMs} (${WORLD_RS_PATH}): ` +
      `${holdCommitMs} + ${FRAME_PERIOD_30FPS_MS.toFixed(2)} + ${LATENCY_MARGIN_MS} < ${stepMs}. ` +
      'A game-core cadence retune now reds CI until the threshold is re-derived ' +
      '(ADR-0158). Teeth verified (8 fixture assertions).',
  };
}
