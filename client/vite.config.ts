import { execSync } from 'node:child_process';
import type { Plugin } from 'vite';
import wasm from 'vite-plugin-wasm';
import { coverageConfigDefaults, defineConfig } from 'vitest/config';
import { resolveConnectionConfig } from './src/net/connectionConfig';
import {
  renderShellConfigScript,
  SHELL_CONFIG_SCRIPT,
  type ShellDocument,
} from './src/net/shellDocument';

// pt-a1: capture the build provenance at build time. The git short-SHA +
// build time are injected as bareword globals (__MR_BUILD_SHA__ / __MR_BUILD_TIME__),
// read by src/net/buildInfo.ts and surfaced in-client + at window.__mrBuild for the
// M-playtest-b F9 bug bundle. Both are env-overridable so the deferred hosted-publish
// path (M-playtest-a2) can stamp its own provenance (e.g. a non-enumerable deploy id).
// This `define` block is independent of the `test`/`coverage` config below (it does not
// touch coverage.exclude/include or allowOnly — see the dom-shell/gate-hardening evals).
function resolveBuildSha(): string {
  if (process.env.MR_BUILD_SHA) return process.env.MR_BUILD_SHA;
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}
const buildSha = resolveBuildSha();
const buildTime = process.env.MR_BUILD_TIME ?? new Date().toISOString();

// The shell document for this tooling's own servers. The client takes its SpacetimeDB target
// from a page global that `/shell-config.js` sets at run time (src/net/shellDocument.ts), so
// `VITE_STDB_URI` / `VITE_STDB_DB` are inputs of this plugin, never of client code:
//   * `vite dev` answers `/shell-config.js` with a document naming them (each trimmed, or the
//     local dev target when unset or blank), kind `test`. Nothing is validated here: the client
//     refuses a bad document at page load, and vitest loads this config too.
//   * `vite build` writes `dist/shell-config.js` the same way, but only when `VITE_STDB_DB` is
//     set (the playtest and `client-verify-build` builds). It first resolves the document as a
//     production client would, so a target that client refuses fails the build. Without
//     `VITE_STDB_DB` the build ships no document and whatever hosts it supplies one.
//   * `vite preview` has no hook: it serves the built file from `dist/`.
function shellConfigPlugin(): Plugin {
  const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const local = resolveConnectionConfig(undefined, true);
  // Both are set by `configResolved`, which Vite runs before the other two hooks.
  let uri = '';
  let db = '';
  const shellDocument = (): ShellDocument => ({
    connection: { uri: uri || local.uri, db: db || local.db, kind: 'test' },
  });
  return {
    name: 'mr-shell-config',
    configResolved(config) {
      uri = trimmed(config.env.VITE_STDB_URI);
      db = trimmed(config.env.VITE_STDB_DB);
    },
    configureServer(server) {
      server.middlewares.use(`/${SHELL_CONFIG_SCRIPT}`, (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.setHeader('Cache-Control', 'no-store');
        res.end(renderShellConfigScript(shellDocument()));
      });
    },
    generateBundle() {
      if (db === '') {
        if (uri !== '') {
          this.warn(
            `VITE_STDB_URI is set but VITE_STDB_DB is not: no ${SHELL_CONFIG_SCRIPT} is written`,
          );
        }
        return;
      }
      const doc = shellDocument();
      resolveConnectionConfig(doc, false);
      this.emitFile({
        type: 'asset',
        fileName: SHELL_CONFIG_SCRIPT,
        source: renderShellConfigScript(doc),
      });
    },
  };
}

// The client-prediction wasm (built `--target bundler` from client-wasm via
// wasm-pack) is consumed through `vite-plugin-wasm`, which resolves the ESM `.wasm`
// import; its async init is a NATIVE top-level await, which is why `build.target` is
// `esnext` below. M3 wires the build/plugins + the headless prediction layer
// (convert + Predictor); M4/M5a binds the live module into the loop.
export default defineConfig({
  // pt-a1: build-provenance globals, replaced at build time by Vite's
  // define (and applied under vitest too, so importing buildInfo.ts never crashes).
  define: {
    __MR_BUILD_SHA__: JSON.stringify(buildSha),
    __MR_BUILD_TIME__: JSON.stringify(buildTime),
  },
  plugins: [wasm(), shellConfigPlugin()],
  // ES2022 keeps the wasm import's top-level await native and pins the syntax ceiling, so a
  // dependency cannot raise the browser floor unnoticed (Chrome 94, Firefox 93, Safari 16.4).
  // A transform plugin for older targets (`vite-plugin-top-level-await`) re-emits every chunk
  // unminified, so none is used.
  build: { target: 'es2022' },
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
    // The boot harness mounts index.html, whose stylesheet <link> resolves against the
    // environment URL (http://localhost:3000, SpacetimeDB's default port). Loading is off so
    // a unit test never opens a socket and runs the same with or without a listener there.
    environmentOptions: { happyDOM: { settings: { disableCSSFileLoading: true } } },
    // Coverage scope for the nightly `just coverage` line-threshold gate.
    // The gate measures HAND-WRITTEN, UNIT-TESTABLE product LOGIC, so it must scope
    // to that — otherwise it is dominated by code vitest is not responsible for
    // (vendored `art-src/`, generated bindings, and render/DOM shells whose behavior
    // is a Playwright concern), making the number meaningless. Keeping the gate
    // meaningful: only non-unit-logic files are excluded — never a
    // logic module. m13.5a re-measured post-exclusion coverage at 99.35% lines and
    // ratcheted the justfile threshold 25 -> 96; this
    // include/exclude set is exact-set-guarded by dom-shell-coverage-exclusion
    // (findUnsanctionedExclusions + include-narrowing tooth) so the denominator
    // cannot silently drift.
    coverage: {
      // Measure the client source tree only (drops the repo-root `playwright.config.ts`,
      // the Playwright `e2e/` specs, and the vendored `art-src/demo/pixi.min.mjs`).
      include: ['src/**/*.ts'],
      exclude: [
        // vitest's built-in default excludes. NOTE:
        // vitest 4 empties coverageConfigDefaults.exclude to [] (it dropped the
        // non-Vitest/Vite default patterns), so this spread no longer drops test
        // files / *.d.ts / configs — it is kept only as a forward-compat spread.
        ...coverageConfigDefaults.exclude,
        // Unit test files: they exercise the product code but are NOT product code,
        // so they must stay OUT of the coverage denominator. Under vitest <=2 the
        // defaults spread above dropped them; under v4 (empty defaults) we exclude
        // them explicitly rather than lean on vitest's undocumented test-file handling.
        'src/**/*.test.ts',
        // Generated SpacetimeDB SDK bindings: emitted by `spacetime generate`,
        // regenerated from the server schema and drift-gated by the bindings-drift
        // eval (`just eval`). Not hand-written, not meaningfully unit-tested.
        'src/module_bindings/**',
        // Render/DOM/bootstrap imperative shells (one-way data flow): their
        // SUBSTANTIVE decision logic lives in the tested pure cores (map,
        // interpolation, slideClock, zorder, viewRegistry, battleModel, boxModel,
        // store, batch, rowConvert), and their behavior is validated by the M5/M7
        // two-window e2e (e2e/golden.spec.ts, e2e/recruit.spec.ts) via window.__game(),
        // never by vitest units. vitest-v8 would always score these 0% regardless of
        // e2e quality (DOM/Pixi/live-SDK, not unit-runnable), so measuring them here is
        // misleading — they are entry/shell files, not unit-coverable logic modules.
        // KNOWN FOLLOW-UP: a little inline glue logic still lives in the integration
        // shells (e.g. main.ts's pvp opponent-name lookup and MOVE_REJECT_PREFIX toast
        // filter; boxView's nickname-changed guard) — boot- or e2e-validated today; the
        // rest moved to pure cores (battleModel, boxModel, battleEmitModel, …).
        'src/main.ts', // integration loop / app bootstrap (window.__game() snapshot)
        'src/net/connection.ts', // live SpacetimeDB adapter (wires store/batch/rowConvert)
        'src/render/world.ts', // WorldRenderer (Pixi); logic = the pure render cores
        'src/render/characterView.ts', // one pooled Pixi sprite per entity
        'src/render/placeholderAssets.ts', // procedural placeholder textures (Pixi Graphics)
        'src/ui/boxView.ts', // thin DOM shell for the box/party screen
        'src/ui/raisingView.ts', // thin DOM shell for the raising/inventory screen
        'src/ui/evolutionView.ts', // thin DOM shell for the evolution/fusion screen
        'src/ui/dialogueView.ts', // thin DOM shell for the dialogue overlay (M12d)
        'src/ui/questLogView.ts', // thin DOM shell for the quest log overlay (M12d)
        'src/ui/healView.ts', // thin DOM shell for the heal overlay (M12d)
        'src/ui/shopView.ts', // thin DOM shell for the shop overlay (M13d)
        'src/ui/tradeView.ts', // thin DOM shell for the trade overlay (m15b)
        'src/ui/pvpView.ts', // thin DOM shell for the PvP challenge overlay (m16b)
        'src/ui/claimView.ts', // thin DOM shell for the guest-claim overlay
        'src/ui/sessionView.ts', // thin DOM shell for the session-lifecycle overlay (M21b-2, D17)
      ],
    },
  },
});
