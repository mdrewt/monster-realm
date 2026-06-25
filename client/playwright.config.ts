import { defineConfig } from '@playwright/test';

// M0b e2e: drives the REAL browser against a running SpacetimeDB instance with
// the `monster-realm` module published. In CI this runs against a containerized
// spacetime (ADR-0009); locally it reuses a running instance + dev server.
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: false,
  use: { baseURL: 'http://localhost:5290', headless: true },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5290',
    // Never reuse a foreign server (another project may hold a common port).
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
