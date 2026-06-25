// Movement prediction-parity eval (ADR-0003, extends the M0 trivial-rule harness):
// the movement rule the client predicts with (the wasm-pack build) must be
// byte-identical to the native game-core `apply_move` the server runs. Movement
// has no RNG, so no seed — just the same inputs through both targets.
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

export function vectorsMatch(native, wasmOuts) {
  if (native.length !== wasmOuts.length) return false;
  return native.every((v, i) => JSON.stringify(v.out) === JSON.stringify(wasmOuts[i]));
}

export default async function () {
  const name = 'movement-parity (native apply_move == wasm-pack build)';

  // Proof-of-teeth: the comparator MUST reject a divergence.
  if (vectorsMatch([{ out: [1, 1, 0, 0] }], [[1, 1, 0, 1]])) {
    return { name, pass: false, detail: 'proof-of-teeth: comparator failed to reject a mismatch' };
  }

  try {
    execSync('wasm-pack build client-wasm --dev --target nodejs --out-dir pkg', {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    return { name, pass: false, detail: `wasm-pack build failed: ${String(e.stderr || e.message).slice(0, 300)}` };
  }
  const pkgPath = path.resolve('client-wasm/pkg/client_wasm.js');
  if (!existsSync(pkgPath)) {
    return { name, pass: false, detail: `wasm pkg not found at ${pkgPath}` };
  }

  let native;
  try {
    const out = execSync('cargo run -q -p sim-harness --bin movement_vectors', { encoding: 'utf8' });
    native = JSON.parse(out.trim());
  } catch (e) {
    return { name, pass: false, detail: `native vectors failed: ${e.message}` };
  }

  const wasm = require(pkgPath);
  const wasmOuts = native.map((v) =>
    Array.from(
      wasm.predict_move(v.in[0], v.in[1], v.in[2], v.in[3], BigInt(v.in[4]), v.in[5], v.in[6], BigInt(v.in[7])),
    ),
  );

  const ok = vectorsMatch(native, wasmOuts);
  return {
    name,
    pass: ok,
    detail: ok
      ? `${native.length} movement vectors identical native<->wasm (teeth verified)`
      : `DIVERGENCE: ${JSON.stringify(native.map((v) => v.out))} vs ${JSON.stringify(wasmOuts)}`,
  };
}
