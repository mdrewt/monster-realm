// JS-path parity eval (ADR-0003 / ADR-0036): the M3 *marshaled* prediction path —
// `apply_move(state, input, now)` over serde_wasm_bindgen JS objects — must agree
// with the flat `predict_move` path, which the prediction/movement-parity evals
// already pin byte-identical to NATIVE `game-core`. So by transitivity the
// marshaled path == native, and this eval isolates a *marshaling* fault (a wrong
// enum tag, a swapped field, a lost `bigint`, a missing time floor) that a build-
// only parity check would miss. Builds the wasm fresh so it tests current source.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

const DIRS = ['North', 'South', 'East', 'West']; //    index == game-core dir code
const ACTIONS = ['Idle', 'Walking', 'Jumping']; //     index == game-core action code

// Pure comparator (teeth-tested below): does the marshaled CharacterState match the
// flat `[x, y, facingCode, actionCode]` the native-verified path returns?
export function statesMatch(flat, marshaled) {
  return (
    marshaled.pos.x === flat[0] &&
    marshaled.pos.y === flat[1] &&
    DIRS.indexOf(marshaled.facing) === flat[2] &&
    ACTIONS.indexOf(marshaled.action) === flat[3]
  );
}

// [x, y, facingCode, actionCode, startedMs, inputKind(0=Step,1=Jump), stepDir, nowMs]
const VECTORS = [
  [1, 1, 0, 0, 0, 0, 2, 200], //   Step East into floor -> (2,1) Walking
  [1, 1, 2, 0, 0, 0, 0, 200], //   Step North into border wall -> bump, Idle, still faces North
  [1, 1, 2, 0, 0, 0, 3, 200], //   Step West into border wall -> bump
  [1, 1, 2, 0, 0, 1, 0, 200], //   Jump East into floor -> (2,1) Jumping
  [3, 3, 2, 0, 0, 1, 0, 205], //   Jump East into inner wall (4,3) -> hop in place, Jumping
  [5, 5, 1, 0, 0, 0, 1, 400], //   Step South
  [1, 1, 0, 0, 0, 0, 2, 200.9], // fractional now -> move_started_at floors to 200
];

export default async function () {
  const name = 'js-path-parity (marshaled serde apply_move == flat predict_move == native)';

  // Proof-of-teeth: the comparator MUST reject a divergence.
  if (
    statesMatch([2, 1, 2, 1], {
      pos: { x: 9, y: 9 },
      facing: 'North',
      action: 'Idle',
      move_started_at: 0,
    })
  ) {
    return { name, pass: false, detail: 'proof-of-teeth: comparator failed to reject a mismatch' };
  }

  try {
    execSync('wasm-pack build client-wasm --dev --target nodejs --out-dir pkg', {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    return {
      name,
      pass: false,
      detail: `wasm-pack build failed: ${String(e.stderr || e.message).slice(0, 300)}`,
    };
  }
  const pkgPath = path.resolve('client-wasm/pkg/client_wasm.js');
  if (!existsSync(pkgPath)) {
    return { name, pass: false, detail: `wasm pkg not found at ${pkgPath}` };
  }
  const wasm = require(pkgPath);

  for (const v of VECTORS) {
    const [x, y, fc, ac, started, ik, sd, now] = v;
    const flooredNow = Math.max(0, Math.floor(now));
    // Flat path (native-verified): now does not affect position/facing/action, so a
    // floored BigInt is safe and keeps the two paths' rule inputs identical.
    const flat = Array.from(
      wasm.predict_move(x, y, fc, ac, BigInt(started), ik, sd, BigInt(flooredNow)),
    );
    // Marshaled path: the real serde objects M4 will hand the predictor.
    const input = ik === 0 ? { Step: DIRS[sd] } : 'Jump';
    const state = {
      pos: { x, y },
      facing: DIRS[fc],
      action: ACTIONS[ac],
      move_started_at: started,
    };
    const marshaled = wasm.apply_move(state, input, now);

    if (!statesMatch(flat, marshaled)) {
      return {
        name,
        pass: false,
        detail: `DIVERGENCE at ${JSON.stringify(v)}: flat=${JSON.stringify(flat)} marshaled=${JSON.stringify(marshaled)}`,
      };
    }
    if (marshaled.move_started_at !== flooredNow) {
      return {
        name,
        pass: false,
        detail: `time-marshal mismatch at ${JSON.stringify(v)}: move_started_at=${marshaled.move_started_at}, want ${flooredNow}`,
      };
    }
  }

  return {
    name,
    pass: true,
    detail: `${VECTORS.length} vectors: serde-marshaled apply_move == flat path + now floored (teeth verified)`,
  };
}
