import { defineConfig } from '@playwright/test';

// Drives a real browser against a running SpacetimeDB. One Playwright process owns one
// database (VITE_STDB_DB: globalSetup publishes it, the client connects to it) and one vite
// dev server (MR_E2E_PORT, default 5290; vite reads it too). Runs split with `--shard=i/N`
// give every shard its own pair: CI's e2e matrix runs one shard per runner, each with its
// own SpacetimeDB, and `just e2e-shards` runs N processes against one local SpacetimeDB.
const e2ePort = process.env.MR_E2E_PORT ?? '5290';
const e2eBaseUrl = `http://localhost:${e2ePort}`;

export default defineConfig({
  testDir: './e2e',
  // A stray `test.only()` must fail CI (never silently skip all other e2e specs).
  // Left permissive locally (CI env var absent) so devs can focus one spec during
  // iteration. GitHub Actions sets CI=true by default. M10.5d — verified 2026-07-04:
  // `CI=1 npx playwright test` exits non-zero when forbidOnly fires.
  forbidOnly: !!process.env.CI,
  // Preconditions: republish the module with --delete-data (zero players).
  globalSetup: './e2e/global-setup.ts',
  timeout: 45_000,
  fullyParallel: false,
  // One worker per process: every spec file in a process shares its one database, and
  // specs assert the EXACT live population (golden.spec: presenceCount === 2) or pick "the
  // other player", so a second file with a player joined at the same time breaks them.
  // `fullyParallel: false` only serializes tests WITHIN a file; `workers: 1` serializes the
  // files. Parallelism comes from shards, each with its own database, never from workers.
  workers: 1,
  // `dot` on CI and `list` locally are Playwright's own defaults, spelled out only so CI
  // can add a per-test timing file (each e2e shard job uploads its own as an artifact): slow specs
  // become visible without scraping logs. The JSON holds titles, durations and error
  // text, so an assertion message must never embed a token.
  reporter: process.env.CI ? [['dot'], ['json', { outputFile: 'test-results/e2e.json' }]] : 'list',
  use: { baseURL: e2eBaseUrl, headless: true },
  webServer: {
    command: 'npm run dev',
    url: e2eBaseUrl,
    // Never reuse a foreign server (another project may hold a common port).
    reuseExistingServer: false,
    timeout: 60_000,
  },
  // Two projects, and the pair is
  // TWO-SIDED ON PURPOSE — each side is mandatory for a different reason:
  //
  //   * `default`'s `testIgnore` is NOT optional. Collection here is by
  //     `testDir: './e2e'`, so without it the reduced-motion spec is ALSO
  //     collected by `default`, runs with NO emulation, and its very first
  //     assertion (`matchMedia('(prefers-reduced-motion: reduce)').matches`)
  //     fails on every PR — `client/package.json`'s `e2e` script is a bare
  //     `playwright test`, which runs every declared project.
  //
  //   * `reduced-motion`'s `testMatch` is NOT optional either. Without it that
  //     project inherits `testDir` and collects the WHOLE e2e suite under
  //     forced reduced motion — including `client/e2e/a11y.spec.ts`, whose own
  //     header forbids a second context on that file (`golden.spec.ts` asserts
  //     an exact `presenceCount === 2`). `testMatch` is deliberately
  //     narrower than a `testIgnore` on this side: it cannot silently widen
  //     when a future spec file is added.
  //
  // THE SPELLING IS LOAD-BEARING AND COUNTERINTUITIVE (MEASURED).
  // The shorthand every Playwright doc page shows — `use: { reducedMotion:
  // 'reduce' }` — DOES NOT EXIST on this repo's pinned @playwright/test 1.61.1:
  // `node_modules/playwright/types/test.d.ts` contains that string exactly
  // once, inside `contextOptions`' doc comment, and there is no such member on
  // the test-options type. It fails `just ci`'s client-typecheck with TS2769,
  // and forced past the type system it is a silent runtime no-op. The nested
  // `contextOptions` form below is the one that reaches `browser.newContext()`.
  //
  // Scoped to this project ALONE, never hoisted into the config-level `use:`
  // above — hoisting merges it into EVERY project and would run every e2e spec
  // file under forced reduced motion, invisibly to the collection counts.
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
