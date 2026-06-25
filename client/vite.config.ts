import { defineConfig } from 'vitest/config';
import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';

// The client-prediction wasm (built `--target bundler` from client-wasm via
// wasm-pack) is consumed through these plugins: `vite-plugin-wasm` resolves the
// ESM `.wasm` import and `vite-plugin-top-level-await` lets the async init run at
// module top level. M3 wires the build/plugins + the headless prediction layer
// (convert + Predictor); M4 binds the live module into the loop (ADR-0036).
export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  server: { port: 5290, strictPort: true },
  // vitest runs the headless unit/property tests under src only; the e2e/ folder
  // is Playwright's (a different runner, driven by `npm run e2e`).
  test: { include: ['src/**/*.test.ts'] },
});
