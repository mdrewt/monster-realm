import { defineConfig } from '@playwright/test';

// M0b e2e: drives the REAL browser against a running SpacetimeDB instance with
// the `monster-realm` module published. In CI this runs against a containerized
// spacetime (ADR-0009); locally it reuses a running instance + dev server.
// e2e port env-driven (default 5290) so concurrent suites use distinct ports
// (set MR_E2E_PORT). Pairs with VITE_STDB_DB (server publish + client connect)
// to give each run its own db + port; the dev server (vite) reads MR_E2E_PORT too.
const e2ePort = process.env.MR_E2E_PORT ?? '5290';
const e2eBaseUrl = `http://localhost:${e2ePort}`;

export default defineConfig({
  testDir: './e2e',
  // A stray `test.only()` must fail CI (never silently skip all other e2e specs).
  // Left permissive locally (CI env var absent) so devs can focus one spec during
  // iteration. GitHub Actions sets CI=true by default. M10.5d — verified 2026-07-04:
  // `CI=1 npx playwright test` exits non-zero when forbidOnly fires.
  forbidOnly: !!process.env.CI,
  // ADR-0009 preconditions: republish the module with --delete-data (zero players).
  globalSetup: './e2e/global-setup.ts',
  timeout: 45_000,
  fullyParallel: false,
  // ONE shared world, ONE worker (13.5h). All spec files share a single published
  // db; golden.spec asserts an EXACT player population (presenceCount === 2), so a
  // concurrently running spec file that keeps its own player joined (recruit.spec
  // holds one for minutes) makes that unreachable. `fullyParallel: false` only
  // serializes tests WITHIN a file — separate files still fan out across workers
  // (observed: 3 workers locally, 2 on 4-vCPU CI runners). Single-worker completes
  // the serialization this config always intended.
  workers: 1,
  use: { baseURL: e2eBaseUrl, headless: true },
  webServer: {
    command: 'npm run dev',
    url: e2eBaseUrl,
    // Never reuse a foreign server (another project may hold a common port).
    reuseExistingServer: false,
    timeout: 60_000,
  },
  // rb-20 (residual R-m23-s11-X11), ADR-0219. Two projects, and the pair is
  // TWO-SIDED ON PURPOSE — each side is mandatory for a different reason:
  //
  //   * `default`'s `testIgnore` is NOT optional. Collection here is by
  //     `testDir: './e2e'`, so without it the reduced-motion spec is ALSO
  //     collected by `default`, runs with NO emulation, and its very first
  //     assertion (`matchMedia('(prefers-reduced-motion: reduce)').matches`)
  //     fails on every PR — `client/package.json`'s `e2e` script is a bare
  //     `playwright test`, which runs every declared project (ADR-0219 D6).
  //
  //   * `reduced-motion`'s `testMatch` is NOT optional either. Without it that
  //     project inherits `testDir` and collects the WHOLE e2e suite under
  //     forced reduced motion — including `client/e2e/a11y.spec.ts`, whose own
  //     header forbids a second context on that file (`golden.spec.ts` asserts
  //     an exact `presenceCount === 2`), and which would double half 3's
  //     `stats.expected` floor in `just a11y-e2e`. `testMatch` is deliberately
  //     narrower than a `testIgnore` on this side: it cannot silently widen
  //     when a future spec file is added (ADR-0219 D2).
  //
  // THE SPELLING IS LOAD-BEARING AND COUNTERINTUITIVE (ADR-0219 D5, MEASURED).
  // The shorthand every Playwright doc page shows — `use: { reducedMotion:
  // 'reduce' }` — DOES NOT EXIST on this repo's pinned @playwright/test 1.61.1:
  // `node_modules/playwright/types/test.d.ts` contains that string exactly
  // once, inside `contextOptions`' doc comment, and there is no such member on
  // the test-options type. It fails `just ci`'s client-typecheck with TS2769,
  // and forced past the type system it is a silent runtime no-op. The nested
  // `contextOptions` form below is the one that reaches `browser.newContext()`.
  //
  // Scoped to this project ALONE, never hoisted into the config-level `use:`
  // above — hoisting merges it into EVERY project and would run all 20 e2e spec
  // files under forced reduced motion, invisibly to the collection counts.
  // Project `use` merges OVER config `use`, so both projects still inherit
  // `baseURL` and `headless`.
  projects: [
    { name: 'default', testIgnore: 'reduced-motion.spec.ts' },
    {
      name: 'reduced-motion',
      testMatch: 'reduced-motion.spec.ts',
      use: { contextOptions: { reducedMotion: 'reduce' } },
    },
  ],
});
