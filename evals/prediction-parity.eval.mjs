// Prediction-parity eval (ADR-0003): the rule the client predicts with (the
// wasm-pack build of `client-wasm`) must produce output byte-identical to the
// native `game-core` path the server compiles. This is the anti-desync spine —
// it catches feature-flag/target divergence before any real rule (M1) depends
// on it. Builds the wasm fresh so it always tests the current source.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Pure comparator (teeth-tested below).
export function vectorsMatch(native, wasmOuts) {
  if (native.length !== wasmOuts.length) return false;
  return native.every((v, idx) => String(v.out) === String(wasmOuts[idx]));
}

export default async function () {
  const name = 'prediction-parity (native game-core == wasm-pack build)';

  // Proof-of-teeth: the comparator MUST reject a divergence.
  if (vectorsMatch([{ out: '1' }], ['2'])) {
    return { name, pass: false, detail: 'proof-of-teeth: comparator failed to reject a mismatch' };
  }

  // Build the wasm (dev/nodejs) so the eval tests the CURRENT source.
  try {
    execSync('wasm-pack build client-wasm --dev --target nodejs --out-dir pkg', {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    const err = String(e.stderr || e.message).slice(0, 400);
    return { name, pass: false, detail: `wasm-pack build failed: ${err}` };
  }

  const pkgPath = path.resolve('client-wasm/pkg/client_wasm.js');
  if (!existsSync(pkgPath)) {
    return { name, pass: false, detail: `wasm pkg not found at ${pkgPath}` };
  }

  // Native (the server path): vectors computed by game-core in a bin.
  let native;
  try {
    const out = execSync('cargo run -q -p sim-harness --bin parity_vectors', { encoding: 'utf8' });
    native = JSON.parse(out.trim());
  } catch (e) {
    return { name, pass: false, detail: `native vectors failed: ${e.message}` };
  }

  // Wasm: the SAME inputs through the wasm-pack build (u64 <-> BigInt).
  const wasm = require(pkgPath);
  const wasmOuts = native.map((v) =>
    String(wasm.predict_tick(BigInt(v.s), BigInt(v.i), BigInt(v.seed))),
  );

  const ok = vectorsMatch(native, wasmOuts);
  return {
    name,
    pass: ok,
    detail: ok
      ? `${native.length} vectors identical native<->wasm (teeth verified)`
      : `DIVERGENCE: ${JSON.stringify(native.map((v) => v.out))} vs ${JSON.stringify(wasmOuts)}`,
  };
}
