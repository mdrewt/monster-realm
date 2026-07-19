# Build Plan: pt-a1 — client-side local-playtest build hygiene

Slice charter: M-playtest-a (local-only playtest build; solo tester; NO hosted deploy) —
FIRST sub-slice. Spec sketch: `specs/monster-realm-v2/M-playtest-a-deployment.spec.md` (harness);
replan `specs/monster-realm-v2/playtest-replan-2026-07.md` §4 (rescope 2026-07-17: local-only).
ADR reserved: **0128**. Built off `master` b31eeab (M17.5 CLOSED).

This spec was a design **sketch**; this doc is the build-time slicing pass that finalizes the EARS +
`touches:` for pt-a1 before any tests (the M17-precedent, commit a356558).

## A) Reconciliation against master b31eeab (what already exists)

The sketch's three client deliverables are NOT greenfield — two of the three already partly landed:

1. **Env-driven connection config — ALREADY EXISTS.** `client/src/main.ts:77-78`:
   `const URI = (import.meta.env.VITE_STDB_URI as string|undefined) ?? 'ws://127.0.0.1:3000';`
   `const DB  = (import.meta.env.VITE_STDB_DB  as string|undefined) ?? 'monster-realm';`
   consumed at `connect({ uri: URI, db: DB, … })` (main.ts:1468). **Gap:** nothing stops a
   *production* build from silently connecting to the dev-default DB `monster-realm` — which would
   corrupt the very H1/H2/H3 playtest feedback the milestone exists to gather — and there are **no
   tests** on the resolution. → pt-a1 extracts a pure resolver with a **prod fail-loud guard**.

2. **DEV-gating of `__game`/`__mrTrade`/`__mrPvp` — ALREADY LANDED** (main.ts:1211-1214, ADR-0127 /
   m17.5f) inside `if (import.meta.env.DEV) { … }`. **RECONCILE, DO NOT RE-IMPLEMENT.** ADR-0127
   flagged a `--minify false` caveat (dead-branch elimination only fires with the minifier on).
   → pt-a1 **empirically verifies** absence from a real minified `vite build` (done during this pass —
   see §D) and documents it; the *automated* build-output regression guard is parked to pt-a2 (§F).

3. **Version stamp — DOES NOT EXIST.** The real net-new work. git short-SHA + build time, injected at
   build via `vite.config.ts` `define`, exposed as a typed `BUILD_INFO`, rendered in-client, and made
   consumable by the M-playtest-b **F9 bug-report bundle** (which embeds "build SHA (M-playtest-a
   stamp)" to pin which build a finding came from across wipe/republish).

4. **Production build/serve path.** `vite build` script already exists in `client/package.json`
   (minified by default); `vite preview` is a vite built-in static-serve path (`npx vite preview` —
   no package.json change). → pt-a1 documents the honest serve path; does NOT touch package.json.

## B) Scope decision — FULL slice (pt-a1-1..-4), tightly bounded

All four EARS ship in ONE mergeable slice: they are one cohesive concern (honest client build
hygiene) and small (~2 new pure modules + 2 test files + 3 wiring/config edits + docs). The one
genuinely heavy candidate — an automated **build-output** DEV-hooks-absent regression test — is
**parked to pt-a2** (§F), where the mechanical release-verification (`dev_reducers`-absent proof
against the published module) already lives and a `scripts/verify-*` home exists. This keeps pt-a1
inside its declared touch-set and avoids bolting a full `vite build` onto the fast vitest suite.

**Single PR, two logical halves** (planner floated a pt-a1a/pt-a1b two-PR split — "preferred, not
mandatory"). Ships as ONE PR because: the supervisor reserved ONE ADR (0128) and framed pt-a1 as one
slice; the eval-gate risk of the config change is LOW and fully mapped (§H — the `define` addition is
outside the `coverage` object); and the combined diff is still small (2 pure modules + 2 test files +
3 surgical edits + docs). Reviewed as two halves (config guard · version stamp) for clarity.
Fallback increment if the combined PR proves large or the config change trips an eval:
(config guard alone) merges first, (version stamp) parks as pt-a1b. Not expected.

## C) Finalized EARS acceptance criteria

- **pt-a1-1 (env-driven config, prod-safe).** WHEN the client resolves its SpacetimeDB connection
  target, the system SHALL read the URI from `VITE_STDB_URI` and the DB name from `VITE_STDB_DB`;
  IF the build is production (`isDev === false`) AND `VITE_STDB_DB` is unset OR equals the dev-default
  `monster-realm`, THEN the system SHALL fail loud (throw a descriptive error) rather than connect
  (reject-not-clamp; parse-don't-validate at the boundary); WHILE running in dev (`isDev === true`),
  the system SHALL fall back to the dev defaults (`ws://127.0.0.1:3000`, `monster-realm`).
- **pt-a1-2 (build version stamp — data).** WHEN the client is built, the system SHALL capture the
  git short-SHA and an ISO build timestamp at build time (both overridable via env for the pt-a2
  publish path; `'unknown'` fallback when git is unavailable) and expose them as a typed
  `BUILD_INFO { sha, builtAt, mode }` available in BOTH dev AND production builds (NOT DEV-gated —
  deliberate contrast with the debug hooks: the F9 bundle runs in the production playtest build).
- **pt-a1-3 (build version stamp — visible + consumable).** WHILE the client is running, the system
  SHALL display the build stamp (short-sha + build time + mode) in a non-intrusive in-client corner
  element, AND SHALL expose it programmatically (`window.__mrBuild` ungated + the `BUILD_INFO` module
  export) so the M-playtest-b F9 bug-report bundle can embed which build a finding came from.
- **pt-a1-4 (honest production build hygiene).** WHEN the client is built for production
  (`vite build`, minified), the DEV-only debug hooks `__game`/`__mrTrade`/`__mrPvp` SHALL be absent
  from the emitted bundle (reconciled from ADR-0127; empirically verified §D), the build stamp SHALL
  remain present in the bundle, AND a production static-serve path (`vite preview`) SHALL be
  available.

## D) Empirical reconciliation evidence (run during this slicing pass, master b31eeab)

`cd client && npx vite build` (default minifier) → `dist/assets/index-*.js` (625 KB). Grep for the
window-binding fingerprints `__mrPvp` / `__mrTrade` / `__game` → **0 matches** (hooks ABSENT). Build
wall time ~5.3 s. Confirms ADR-0127's mechanism holds on master.

**Refined finding on the ADR-0127 `--minify false` caveat.** A `vite build --minify false` build ALSO
emits **0** `__game`/`__mrTrade`/`__mrPvp` window bindings — the `if (import.meta.env.DEV)` guard is
define-replaced to `if (false)` and its window-assignment branch is eliminated by **Rollup's DCE**,
which runs independent of minification. The unminified build does retain the (now unreferenced) hook
*object literals* (`challengePvp`/`proposeTrade` strings appear), but they are NOT attached to
`window` and so are unreachable. So the security-relevant surface — the `window.__*` binding — is gone
even unminified; minification additionally strips the dead object literals for a clean bundle. The
honest playtest build uses the DEFAULT minified `vite build` regardless. pt-a1's stamp/config
additions do not reintroduce the hooks (re-verified post-implementation, §D-post). Recorded in
ADR-0128 as a precision refinement of ADR-0127's caveat (not a reversal).

## E) Tasks (functional-core / imperative-shell split)

Pure, unit-tested cores; the DOM/bootstrap wiring stays in the already-coverage-excluded `main.ts`.

### T1 — pure connection-config resolver (pt-a1-1)
- NEW `client/src/net/connectionConfig.ts`: `resolveConnectionConfig(input: { uri?: string; db?: string;
  isDev: boolean }): { uri: string; db: string }`. Pure (env + isDev passed IN — no `import.meta`
  reference inside, so it is deterministically unit-testable). Dev: fall back to
  `ws://127.0.0.1:3000` / `monster-realm`. Prod: require a non-empty `db` that is not the literal
  dev-default `monster-realm`, else `throw new Error(...)` naming `VITE_STDB_DB`.
  **GUARD THE DB ONLY, NOT THE URI** (planner correction): `ws://127.0.0.1:3000` is the *legitimate*
  local-playtest topology (replan §4 local-only), so the uri falls back to that default in BOTH dev and
  prod — guarding the uri would false-reject the real playtest setup. The DB name is the corruption
  vector (wrong DB = wrong data); the uri is not. Decision recorded in ADR-0128.
- NEW sibling `connectionConfig.test.ts` — proof-of-teeth (§G).
- `main.ts` wires it: `const { uri, db } = resolveConnectionConfig({ uri: import.meta.env.VITE_STDB_URI,
  db: import.meta.env.VITE_STDB_DB, isDev: import.meta.env.DEV });` replacing the `URI`/`DB` consts,
  passed into `connect({ uri, db, … })`.

### T2 — build-info module (pt-a1-2 / -3, data + formatter)
- NEW `client/src/net/buildInfo.ts` (placement: `net/` — it is provenance DATA consumed by the F9
  observability bundle; `net/**` is in-touch-set and it is a LOGIC module so it is coverage-MEASURED,
  NOT excluded). Module-scoped ambient `declare const __MR_BUILD_SHA__: string;` +
  `declare const __MR_BUILD_TIME__: string;` co-located here (avoids a `vite-env.d.ts` touches-delta —
  only this file references the injected globals; a module-scoped `declare` satisfies tsc).
  Pure `buildInfoFrom(sha: string, builtAt: string, isDev: boolean): BuildInfo` (tested with params) +
  `formatBuildStamp(info: BuildInfo): string` (pure); `export const BUILD_INFO = buildInfoFrom(
  typeof __MR_BUILD_SHA__ !== 'undefined' ? __MR_BUILD_SHA__ : 'unknown', typeof __MR_BUILD_TIME__ !==
  'undefined' ? __MR_BUILD_TIME__ : 'unknown', import.meta.env.DEV)` — the only impure line, one
  statement. `BuildInfo = { sha: string; builtAt: string; mode: 'dev' | 'production' }`.
- NEW sibling `buildInfo.test.ts` — `buildInfoFrom` + `formatBuildStamp` teeth (§G).

### T3 — vite.config.ts build-time injection (pt-a1-2)
- Add a top-level `define` computing the short-SHA (`execSync('git rev-parse --short HEAD')`,
  try/catch → `'unknown'`; env override `MR_BUILD_SHA`) and time (`MR_BUILD_TIME` env override else
  `new Date().toISOString()`): `define: { __MR_BUILD_SHA__: JSON.stringify(sha), __MR_BUILD_TIME__:
  JSON.stringify(time) }`. **Do NOT** touch `test.coverage.include/exclude` or `test.allowOnly`
  (eval guards, §H). `define` sits alongside `plugins`/`server`/`test`, outside `coverage`.

### T4 — in-client render + F9 hook (pt-a1-3)
- `client/index.html`: add `<div id="build-stamp" style="…corner, low-z, muted…"></div>` mount.
- `main.ts`: render `formatBuildStamp(BUILD_INFO)` into `#build-stamp`; assign
  `(window as …).__mrBuild = BUILD_INFO` **ungated** (present in prod — the F9 consumer needs it).
  Render logic lives in the coverage-excluded shell; the tested logic is `formatBuildStamp`.

### T5 — docs
- This plan doc; `docs/adr/0128-*.md` (ADR — new fail-loud config behavior + build-stamp contract +
  DEV-gating reconciliation record); minimal `ARCHITECTURE.md` client-section addition.

## F) Parked to pt-a2 (explicit, not dropped)
- **Automated DEV-hooks-absent build-output regression guard** (`vite build` → grep dist for
  `__game/__mrTrade/__mrPvp`): belongs with pt-a2's mechanical release-verification (the
  `dev_reducers`-absent proof against the published module) where a `scripts/verify-*` + `justfile`
  home exists; too heavy for the fast vitest unit suite; `evals/run.mjs` is off-limits to pt-a1.
- `just playtest-up`/`playtest-down`, release-publish, wipe/republish, `docs/playtest-ops.md`
  (all pt-a2). ALL hosted deployment (re-booked M-playtest-a2).

## G) Proof-of-teeth (must BITE)
- **config-prod-dev-default → throws** (pt-a1-1): `resolveConnectionConfig({ db: 'monster-realm',
  isDev: false })` MUST throw; a resolver that returns it unguarded → RED. Also: prod + unset db →
  throws; prod + `monster-realm-playtest` → ok; dev + unset → dev defaults (no throw).
- **formatBuildStamp** (pt-a1-2/-3): stamp string MUST contain the sha and mode; an empty/na sha
  formats to a recognizable `unknown` marker (F9 must never embed a blank build id).
- **DEV-hooks-absent** (pt-a1-4): empirically verified §D + documented; automated guard parked (§F).

## H) Eval-gate risks (must not trip `node evals/run.mjs`)
- `dom-shell-coverage-exclusion.eval.mjs`: `findUnsanctionedExclusions` rejects ANY entry in
  `coverage.exclude` outside the sanctioned DOM_SHELLS set. → **Do NOT add a new file to
  coverage.exclude.** Render the stamp inside the already-excluded `main.ts`; keep `buildInfo.ts`
  UNIT-TESTED (measured, not excluded). `coverageIncludeIsFull` requires `include: ['src/**/*.ts']` —
  don't narrow. My `define` addition is outside the `coverage` object → not scanned by this eval.
- `gate-hardening-config.eval.mjs`: requires `allowOnly: false` stays in vite.config.ts → preserve.
- `build-ci-hygiene.eval.mjs`: checks justfile/workflows/package.json/Cargo/devcontainer/biome —
  none touched. `client/dist/` is gitignored + biome-excluded (`!client/dist`), so a stray build
  artifact won't trip `biome check .`.
- New pure modules are coverage-measured (nightly threshold 96 lines) — test them thoroughly.

## I) Anti-patterns to avoid
- Reading `import.meta` INSIDE the pure resolver (breaks unit-testability) — pass env + isDev in.
- Clamping instead of rejecting when the prod DB is the dev-default (silent corruption of feedback).
- DEV-gating the build stamp (the F9 bundle runs in the prod build — the stamp MUST be present).
- Adding a new DOM-shell file to `coverage.exclude` (trips the exact-set guard).
- A dynamic `new RegExp(...)` anywhere in tests/tooling (Semgrep `detect-non-literal-regexp` has
  bitten this repo 3×) — literal regex or `String.includes/indexOf` only.
- Hand-editing CHANGELOG.md (git-cliff-generated) or `docs/adr/README.md` (supervisor-owned).

## J) touches:
`client/src/net/connectionConfig.ts` (+ `.test.ts`), `client/src/net/buildInfo.ts` (+ `.test.ts`),
`client/vite.config.ts`, `client/src/main.ts`, `client/index.html`,
`docs/specs/pt-a1-plan.md`, `docs/adr/0128-*.md`, minimal `ARCHITECTURE.md`.
No `package.json`, no `module_bindings/**`, no `evals/**`, no `server-module/**`, no `game-core/**`,
no lockfiles. Any file beyond this set is recorded under `touches-delta:` in the PR body.
