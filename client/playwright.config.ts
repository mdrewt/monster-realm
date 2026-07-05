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
});
