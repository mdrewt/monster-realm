import topLevelAwait from 'vite-plugin-top-level-await';
import wasm from 'vite-plugin-wasm';
import { coverageConfigDefaults, defineConfig } from 'vitest/config';

// The client-prediction wasm (built `--target bundler` from client-wasm via
// wasm-pack) is consumed through these plugins: `vite-plugin-wasm` resolves the
// ESM `.wasm` import and `vite-plugin-top-level-await` lets the async init run at
// module top level. M3 wires the build/plugins + the headless prediction layer
// (convert + Predictor); M4/M5a binds the live module into the loop (ADR-0036).
export default defineConfig({
  plugins: [wasm(), topLevelAwait()],
  // The wasm pkg lives at <repo>/client-wasm/pkg (one level above the client
  // root); allow the dev/preview server to serve it (M5a integration).
  // e2e/dev port env-driven (default 5290) for concurrent-run isolation (MR_E2E_PORT).
  server: {
    port: Number(process.env.MR_E2E_PORT) || 5290,
    strictPort: true,
    fs: { allow: ['..'] },
  },
  // vitest runs the headless unit/property tests under src only; the e2e/ folder
  // is Playwright's (a different runner, driven by `npm run e2e`).
  test: {
    include: ['src/**/*.test.ts'],
    // A stray `.only` / `it.only` / `describe.only` must FAIL the run, never
    // silently narrow the gate to a single test and produce a false-green build.
    // M10.5d: Verified 2026-07-04 — adding `it.only(...)` locally causes
    // `npm test` to exit non-zero with "allowOnly is false" diagnostic.
    allowOnly: false,
    // Coverage scope for the nightly `just coverage` line-threshold gate (ADR-0050).
    // The gate measures HAND-WRITTEN, UNIT-TESTABLE product LOGIC, so it must scope
    // to that — otherwise it is dominated by code vitest is not responsible for
    // (vendored `art-src/`, generated bindings, and render/DOM shells whose behavior
    // is a Playwright concern), making the number meaningless. Keeping the gate
    // meaningful (ADR-0009/0010): the threshold is UNCHANGED; only non-unit-logic
    // files are excluded — never a logic module.
    coverage: {
      // Measure the client source tree only (drops the repo-root `playwright.config.ts`,
      // the Playwright `e2e/` specs, and the vendored `art-src/demo/pixi.min.mjs`).
      include: ['src/**/*.ts'],
      exclude: [
        // Preserve vitest's defaults (test files, *.d.ts, common configs, node_modules)
        // — a custom `exclude` REPLACES them otherwise.
        ...coverageConfigDefaults.exclude,
        // Generated SpacetimeDB SDK bindings: emitted by `spacetime generate`,
        // regenerated from the server schema and drift-gated by the bindings-drift
        // eval (`just eval`, ADR-0050). Not hand-written, not meaningfully unit-tested.
        'src/module_bindings/**',
        // Render/DOM/bootstrap imperative shells (ADR-0014 one-way flow): their
        // SUBSTANTIVE decision logic lives in the tested pure cores (map,
        // interpolation, slideClock, zorder, viewRegistry, battleModel, boxModel,
        // store, batch, rowConvert), and their behavior is validated by the M5/M7
        // two-window e2e (e2e/golden.spec.ts, e2e/recruit.spec.ts) via window.__game(),
        // never by vitest units. vitest-v8 would always score these 0% regardless of
        // e2e quality (DOM/Pixi/live-SDK, not unit-runnable), so measuring them here is
        // misleading — they are entry/shell files, not unit-coverable logic modules.
        // KNOWN FOLLOW-UP: a little inline glue logic still lives in the integration
        // shells (e.g. main.ts's Escape terminal-dismiss latch + party-slot sentinel
        // routing; battleView's bait-id parse; boxView's nickname-changed guard) —
        // e2e-validated today; extracting it into pure cores for unit coverage is a
        // separate client slice (this slice does not touch client/src logic).
        'src/main.ts', // integration loop / app bootstrap (window.__game() snapshot)
        'src/net/connection.ts', // live SpacetimeDB adapter (wires store/batch/rowConvert)
        'src/render/world.ts', // WorldRenderer (Pixi); logic = the pure render cores
        'src/render/characterView.ts', // one pooled Pixi sprite per entity
        'src/render/placeholderAssets.ts', // procedural placeholder textures (Pixi Graphics)
        'src/ui/battleView.ts', // thin DOM shell for the battle screen
        'src/ui/boxView.ts', // thin DOM shell for the box/party screen
        'src/ui/raisingView.ts', // thin DOM shell for the raising/inventory screen
        'src/ui/evolutionView.ts', // thin DOM shell for the evolution/fusion screen
        'src/ui/dialogueView.ts', // thin DOM shell for the dialogue overlay (M12d)
        'src/ui/questLogView.ts', // thin DOM shell for the quest log overlay (M12d)
        'src/ui/healView.ts', // thin DOM shell for the heal overlay (M12d)
        'src/ui/shopView.ts', // thin DOM shell for the shop overlay (M13d)
      ],
    },
  },
});
