# Build Plan: pt-a2 — LOCAL-only playtest ops (solo tester; no hosted deploy)

Slice charter: M-playtest-a's 2nd sub-slice. Off master `d423d0d` (worktree
`feat/pt-a2-playtest-ops`). ADR reserved **0129**. Spec sketch:
`specs/monster-realm-v2/M-playtest-a-deployment.spec.md` (harness); replan
`specs/monster-realm-v2/playtest-replan-2026-07.md` §4 (rescope 2026-07-17:
local-only, solo tester). This doc is the build-time slicing pass that finalizes
EARS + `touches:` before any tests (M17-precedent, commit a356558).

## A) Reconciliation against master d423d0d (what already exists)

pt-a2 is NOT greenfield — it stands on two strong precedents and one parked hand-off:

1. **`scripts/smoke-republish.sh` + `just smoke-republish`** — the exact
   publish→call→sql→republish→sync_content flow, isolated DB name
   (`monster-realm-smoke`), nightly-only (needs a live instance). Load-bearing
   quirks it already encodes (reuse, don't re-derive):
   - `spacetime publish -s "$SERVER" --module-path server-module --delete-data -y "$DB"` (fresh publish).
   - `spacetime publish -s "$SERVER" --module-path server-module -y "$DB"` (republish WITHOUT `--delete-data` — data survives per ADR-0006/0037).
   - Each reducer arg is its own JSON value: `spacetime call ... sync_content` (owner-callable since 12.5b-1); a wrapping JSON array double-nests and the server rejects it (ADR-0088).
   - `#!/usr/bin/env bash` + `set -euo pipefail`; `if ! VAR=$(cmd)` form (bare `VAR=$(cmd)` suppresses `set -e`); word-boundary grep anchoring.
   - Its wiring is gated by `evals/nightly-smoke-wiring.eval.mjs` — the eval idiom this slice adopts.

2. **pt-a1 (ADR-0128) client build hygiene** — already landed on d423d0d:
   - `client/vite.config.ts` already has the `define` block injecting `__MR_BUILD_SHA__`/`__MR_BUILD_TIME__` (env-overridable `MR_BUILD_SHA`/`MR_BUILD_TIME`). **No client/vite change is required by pt-a2** — the dist-grep guard reads the emitted artifact, not config.
   - `client/package.json` already has `"build": "vite build"` (minified by default). `vite preview` is a vite built-in (`npx vite preview`) — no package.json change.
   - The DEV hooks `__game`/`__mrTrade`/`__mrPvp` are gated behind `if (import.meta.env.DEV)` and **empirically absent from a minified AND `--minify false` build** (ADR-0128 §D3 — Rollup DCE eliminates the `window.__*` binding independent of minification; only dead object literals linger unminified). **Load-bearing fingerprint fact:** the fingerprint MUST be the `window`-binding form, not a bare substring, or an unminified build false-flags the dead `challengePvp`/`proposeTrade` object literals (ADR-0128 §D3 Residual F-4).

3. **pt-a1 §F explicitly parked to pt-a2** (`docs/specs/pt-a1-plan.md:147-153`): the
   automated **build-output DEV-hooks-absent regression guard** (real `vite build`
   → grep `dist`), PLUS `just playtest-up`/`playtest-down`, release-publish,
   wipe/republish, and `docs/playtest-ops.md`. This slice discharges exactly that hand-off.

4. **dev_reducers gating (ADR-0054), confirmed in source at d423d0d:** feature
   `dev_reducers = []` in `server-module/Cargo.toml:32` (OFF by default). The ONLY two
   functions carrying BOTH `#[cfg(feature="dev_reducers")]` AND
   `#[spacetimedb::reducer]` are **`start_wild_battle`** (`battle.rs:460`) and
   **`grant_bait`** (`taming.rs:272`) — verified by grep at d423d0d and matching the
   canonical set in `dev-reducer-gating.eval.mjs`. **`grant_item`
   (`inventory.rs:31`) is a `pub(crate) fn` HELPER, NOT a reducer** — it has no
   `#[spacetimedb::reducer]` attribute and can NEVER appear in `spacetime describe`,
   so it is NOT in `forbiddenNames` (red-team Finding 1). `forbiddenNames =
   ['start_wild_battle', 'grant_bait']` (exactly 2). spacetime 2.6.0 has NO cargo-feature passthrough
   on `publish`, so the DEFAULT `spacetime publish --module-path server-module <db>`
   (release profile) OMITS all three. The honest playtest publish is exactly that
   default. **The proof must confirm absence against the PUBLISHED module, not the
   source** — a wrong `--features`/`--bin-path` in the publish path is precisely the
   failure this guards (spec risk note).

5. **`spacetime describe` (2.6.0) confirmed:** `spacetime describe [OPTIONS] --json
   [DATABASE] [ENTITY_TYPE ENTITY_NAME]`. **`--json` is REQUIRED in 2.6.0**
   ("Currently required; in the future, omitting this will give human-readable
   output"). So the release-verify driver uses `spacetime describe --json
   "$MR_PLAYTEST_DB"` and the pure checker parses JSON. (The exact JSON location of
   reducer names is confirmed empirically against a live instance during impl; the
   checker is written robustly — JSON parse with a raw-token-scan fallback.)

## B) Scope decision + right-sizing — SHIP WHOLE (pt-a2-1..-6), ONE deferral to pt-a3

**Ship the cohesive "honest local playtest ops" as ONE mergeable slice.** The
pieces are one concern (an operator publishes an honest release module to an
isolated DB, serves the honest client build, wipes/resets, and knows which build
they're on) and each is minimal: 2 `verify-*` node scripts (pure checker + thin
driver each), 1 new eval, ~5 justfile recipes, 1 runbook, 1 ADR.

**Why right-sized, not bloated:** the heavy, un-CI-able parts (live publish, live
`spacetime describe`, real `vite build`) are NOT in `just ci` — same class as
`smoke-republish`/`e2e`. `just ci` gates only pure-logic checkers + structural
scans; the live drivers run manually via `just playtest-up`/`playtest-verify-*`.
No "bolt a live instance / vite build onto the fast loop" cost forces a split.

**Explicit pt-a3 deferral (ONE item):** a **live end-to-end `playtest-smoke`
recipe** (start instance → `playtest-up` → introspect published module → curl the
served client → assert), the pt-a2 analogue of `smoke-republish` wired into
nightly. Defer because (a) it needs a live instance + running preview + nightly
orchestration that pt-a2's structural scans already prove *wired*; (b) it would add
a nightly.yml job (a workflow touch outside the declared set + a supervisor-owned
surface); (c) YAGNI for a solo local tester running `playtest-up` by hand. **Do not
defer any of the 6 criteria below** — they are the cohesive minimum.

## C) Finalized EARS acceptance criteria

- **pt-a2-1 (playtest-up — honest release publish to isolated DB).** WHEN the
  operator runs `just playtest-up`, the system SHALL publish the DEFAULT
  release-profile module (`spacetime publish -s <server> --module-path server-module
  <db>`, `dev_reducers` ABSENT — no `--features`, no `--bin-path`) to the LOCAL
  instance under DB name **`monster-realm-playtest`** (never the dev-default
  `monster-realm`), SHALL call `sync_content` as owner after (re)publish (ADR-0006),
  SHALL build the client with `vite build`, and SHALL serve the production build via
  `vite preview`. The DB name and server are env-overridable (`MR_PLAYTEST_DB`
  default `monster-realm-playtest`; `STDB_SERVER` default `http://127.0.0.1:3000`)
  but the default MUST be the isolated playtest DB.

- **pt-a2-2 (playtest-down — teardown).** WHEN the operator runs `just
  playtest-down`, the system SHALL stop the served client preview (and document that
  the module/data persist unless wiped) so the operator can cleanly end a session.

- **pt-a2-3 (release-publish dev_reducers-absent proof against the PUBLISHED
  module).** WHEN the operator runs `just playtest-verify-release` (also invoked by
  `playtest-up` after publish), the system SHALL introspect the PUBLISHED
  SpacetimeDB module via CLI (`spacetime describe --json`), SHALL detect any of the
  dev-only reducers `start_wild_battle`/`grant_bait` (the two cfg-gated reducers; see
  §K/§A-4 — `grant_item` is a helper, not a reducer) in the published reducer list,
  AND SHALL fail loud if the introspection itself fails/returns no reducers (§K),
  and IF any forbidden reducer is present THEN SHALL fail loud (non-zero exit, naming
  the offender) — reject-not-clamp. The check inspects the published module, NOT the
  source. Pure detector `findForbiddenReducers(describeOutput, forbiddenNames) ->
  string[]` (offenders; empty = pass) separated from the CLI driver
  (functional-core/imperative-shell).

- **pt-a2-4 (build-output DEV-hooks-absent regression guard).** WHEN the operator
  runs `just playtest-verify-build` (also invoked by `playtest-up` after `vite
  build`), the system SHALL scan the emitted `client/dist/**/*.js`, SHALL detect the
  DEV debug-hook `window`-BINDINGS `window.__game`/`window.__mrTrade`/`window.__mrPvp`
  (the binding form, NOT a bare substring — a `--minify false` build legitimately
  retains dead object literals per ADR-0128 §D3), and IF any binding is present THEN
  SHALL fail loud (non-zero exit, naming the offender). Pure detector
  `findDevHooks(bundleText, fingerprints) -> string[]` separated from the
  file-reading driver.

- **pt-a2-5 (wipe / republish-with-content-resync).** WHEN the operator runs `just
  playtest-wipe`, the system SHALL republish with `--delete-data -y` (fresh state) to
  `monster-realm-playtest` and re-run `sync_content`, AND the runbook SHALL document
  the 13.5c-4 owner-re-register note (after `--delete-data`, `init` re-runs and the
  publishing identity is re-registered as owner; a `sync_content` call must come from
  that owner identity). The republish-WITHOUT-`--delete-data` path (live content
  update, data survives) SHALL also be available via re-running `playtest-up`.

- **pt-a2-6 (runbook).** WHERE `docs/playtest-ops.md` exists, it SHALL document:
  playtest-up/down; wipe/reset (with the owner-re-register note);
  republish-with-content-resync; and a "which build am I on" check (read
  `window.__mrBuild` / the `#build-stamp` element per ADR-0128, and the published DB
  name).

## D) Tasks (functional-core / imperative-shell split + exact file list)

Invariant: pure checkers (unit-testable, imported by the CI eval) separated from
CLI/FS drivers (runnable only against a live instance / a real `dist`). The
main-guard pattern keeps the eval import from running the live driver.

### T1 — `scripts/verify-release-reducers.mjs` (pt-a2-3)
- **Pure core (exported):** `findForbiddenReducers(describeOutput, forbiddenNames)`
  → `string[]`. Parse `spacetime describe --json <db>` output: `JSON.parse`, collect
  reducer names (confirm the exact JSON path live), exact-match against
  `forbiddenNames`; on parse failure fall back to a raw-token scan for each forbidden
  name. `String.includes`/`indexOf` + literal patterns only — **NO `new RegExp(...)`**
  (Semgrep `detect-non-literal-regexp`, 3× bites). `forbiddenNames` defaults to
  `['start_wild_battle', 'grant_bait', 'grant_item']`.
- **Impure driver (main-guarded):** `if (import.meta.url ===
  pathToFileURL(process.argv[1]).href) { ... }` — runs `execFileSync('spacetime',
  ['describe', '--json', db])` (also pass `-s $STDB_SERVER`), feeds output to
  `findForbiddenReducers`, prints offenders, `process.exit(offenders.length ? 1 : 0)`.
  DB from `MR_PLAYTEST_DB` env (default `monster-realm-playtest`).

### T2 — `scripts/verify-build-hooks.mjs` (pt-a2-4)
- **Pure core (exported):** `findDevHooks(bundleText, fingerprints)` → `string[]`.
  Fingerprints = the `window`-binding form (ADR-0128 §D3): `.__game=` / `.__game =`,
  `.__mrTrade=` / `.__mrTrade =`, `.__mrPvp=` / `.__mrPvp =`, plus bracket-assignment
  `["__game"]`/`['__game']` (etc) defensively. Match via `String.includes` on
  whitespace-normalized text. This bites `window.__mrPvp =` / `w.__mrPvp=` while a
  dead object literal `{challengePvp:...}` (no `.__mrPvp` receiver) does NOT match.
  Do NOT include a bare `__game` substring. **NO `new RegExp`.**
- **Impure driver (main-guarded):** recursively read `client/dist/**/*.js`, concat,
  feed to `findDevHooks`, print offenders + file, `process.exit(offenders.length ? 1
  : 0)`. If `dist` absent → fail loud ("run vite build first").

### T3 — justfile recipes (pt-a2-1/-2/-3/-4/-5) — STRUCTURAL, always-serial
Bash-shebang bodies (`#!/usr/bin/env bash` + `set -euo pipefail`) per-recipe
(overrides `windows-shell`, like `mutate-server`). Recipes call the
`scripts/verify-*` drivers (keeps `scripts/` confined to `verify-*`; NO
`scripts/playtest-*.sh`). Reuse the exact `smoke-republish.sh` CLI arg shapes. Env:
`STDB_SERVER` (default `http://127.0.0.1:3000`), `MR_PLAYTEST_DB` (default
`monster-realm-playtest`).
- `playtest-up`: guard DB ≠ `monster-realm` → `spacetime build` → `spacetime publish
  ... "$MR_PLAYTEST_DB"` (no `--delete-data`, no `--features`/`--bin-path`) →
  `spacetime call ... sync_content` → `just playtest-verify-release` → `cd client &&
  npx vite build` → `just playtest-verify-build` → `cd client && npx vite preview`.
- `playtest-down`: stop the preview server (document persistence; PID-file or
  documented Ctrl-C — implementer picks the concrete mechanism).
- `playtest-verify-release`: `node scripts/verify-release-reducers.mjs`.
- `playtest-verify-build`: `node scripts/verify-build-hooks.mjs`.
- `playtest-wipe`: guard DB ≠ `monster-realm` → `spacetime publish ... --delete-data
  -y "$MR_PLAYTEST_DB"` → `spacetime call ... sync_content` (owner re-registered by
  `init` after delete-data — 13.5c-4).
- **CRITICAL default-DB guard:** each publish/wipe recipe MUST fail loud if
  `$MR_PLAYTEST_DB` resolves to the literal dev-default `monster-realm`
  (reject-not-clamp; server-ops mirror of ADR-0128's client DB guard). Pinned by the
  eval's recipe scan (§F).
- **`ci` line: UNCHANGED** — these recipes need a live instance / real `dist` (same
  reason `smoke-republish` is nightly-only). CI gets the eval, not the live recipe.

### T4 — `evals/playtest-verify.eval.mjs` (CI teeth) — **touches-delta**
NEW auto-discovered eval (`evals/run.mjs` globs `*.eval.mjs`). Imports the two pure
checkers + runs structural source-scans (§E/§F). Flagged as a deliberate
`touches-delta` (safe: SERIAL slice, no concurrent sibling owns `evals/**`).
**`evals/run.mjs` itself is NOT touched.**

### T5 — docs
- `docs/playtest-ops.md` (pt-a2-6 runbook).
- `docs/adr/0129-pt-a2-local-playtest-ops.md` — the non-obvious "why":
  describe-against-published-module (not source grep) rationale; window-binding
  fingerprint precision (ADR-0128 §D3 link); isolated-DB + default-DB
  reject-not-clamp; pure-checker/driver split + main-guard; why CI gates only the
  pure checkers (no live instance in `just ci`); pt-a3 deferral. Canonical ADR-0104
  header block. Run `just adr-digest` after. **Do NOT touch `docs/adr/README.md` or
  the ADR index.**
- Minimal targeted `ARCHITECTURE.md` addition (one playtest-ops paragraph). **Do NOT
  hand-edit `CHANGELOG.md`** (git-cliff).

## E) Proof-of-teeth (must BITE — one per criterion)

All teeth live in `evals/playtest-verify.eval.mjs`, repo idiom (known-BAD fixture
first → must reject; known-GOOD → must pass; then real-file checks). **NO `new
RegExp`.**

- **pt-a2-3 (`findForbiddenReducers`):** BAD fixtures = a `describe --json` blob
  containing each of `start_wild_battle`/`grant_bait`/`grant_item` (separately) →
  offenders non-empty → driver would `exit 1`. GOOD fixture = a describe blob listing
  only production reducers (`join_game`, `sync_content`, `start_pvp_battle`,
  `battle_action`, ...) → offenders empty → pass. No-false-positive tooth: a
  production reducer that shares a token (e.g. `sync_content`) must not be flagged
  (exact-token match).
- **pt-a2-4 (`findDevHooks`):** BAD fixtures = `window.__mrPvp = function(){...}`,
  `w.__game=`, `window.__mrTrade =` → offenders → `exit 1`. GOOD-clean fixture =
  minified bundle with none → pass. **Critical anti-false-positive tooth (ADR-0128
  §D3):** a fixture containing the DEAD object literal
  `{challengePvp:()=>{},proposeTrade:()=>{}}` and bare tokens `__mrPvp`/`__game` in a
  source-map comment, but NO `.__mrPvp=`/`.__game=` binding → MUST pass. Proves the
  fingerprint is the binding form, not the bare substring.
- **pt-a2-1 / -5 (recipe structural scans, reuse `extractRecipeBody` from
  `build-ci-hygiene.eval.mjs`):** `playtest-up` body BAD = publishes to
  `monster-realm` (dev-default) → rejected; GOOD = publishes to
  `monster-realm-playtest`/`$MR_PLAYTEST_DB` AND calls `sync_content` AND invokes
  `verify-release`/`verify-build` AND `vite build`/`vite preview`. BAD = body contains
  `--features dev_reducers` or `--bin-path` → rejected (honest publish = default
  publish). `playtest-wipe` GOOD = contains `--delete-data` AND a follow-up
  `sync_content`. Recipe-references-script tooth: `playtest-verify-release` body
  contains `verify-release-reducers.mjs`; `playtest-verify-build` contains
  `verify-build-hooks.mjs`. Script-existence + exports-checker tooth: both
  `scripts/verify-*.mjs` exist, non-trivial, export their pure checker.
- **pt-a2-2 / -6 (structural):** `playtest-down` recipe exists; `docs/playtest-ops.md`
  exists and mentions `playtest-up`, `playtest-wipe`, `sync_content`,
  `window.__mrBuild` (or `#build-stamp`), and the owner-re-register note
  ("re-register"/"owner"/"init"). ADR-0129 exists and documents the describe-published
  rationale.

## F) CI-gating strategy — why the eval is DoD-sufficient given no live instance in `just ci`

`just ci` = `lint typecheck test eval security wasm client-typecheck client-test`.
NONE runs a live spacetime instance, a real `spacetime describe`, or a `vite build`.
So pt-a2's runtime behavior CANNOT execute in `just ci` — same class as
`smoke-republish`/`e2e`. The only auto-run home for a per-PR gate is an eval (`node
evals/run.mjs`, wired via the `eval` recipe).

**One new eval `evals/playtest-verify.eval.mjs` asserts three layers, together
DoD-sufficient:**
1. **Pure-checker correctness** — imports `findForbiddenReducers`/`findDevHooks` and
   proves BITE-on-bad + PASS-on-good + no-false-positive (§E). The load-bearing logic;
   fully exercised with NO live instance.
2. **Wiring integrity** — structural scans prove `playtest-up`/`verify-release`/
   `verify-build`/`wipe` recipes exist, publish to the isolated DB (not
   `monster-realm`), use the DEFAULT publish (no `--features`/`--bin-path`), and invoke
   the verify scripts. Closes the "someone rewrites `playtest-up` to publish
   dev_reducers or to the dev DB" regression at PR time.
3. **Artifact presence** — the two `scripts/verify-*.mjs` exist, are non-trivial,
   export their pure cores.

What CI does NOT prove (correctly deferred to the manual/live run): that a *real*
`spacetime describe` output parses, and a *real* `vite build` dist is clean — those
run in `just playtest-verify-release`/`playtest-verify-build` (invoked by
`playtest-up`), the operator's local gate, exactly analogous to `smoke-republish`
being nightly-only. **DoD = eval green in `just ci` + a documented, self-verifying
`playtest-up`.** The eval imports pure functions + static fixtures only (no
`execFileSync`, no `dist` reads); the main-guard ensures importing does NOT run the
live driver.

## G) Eval-gate risks (must not trip existing `node evals/run.mjs`)

- **`spec-gap-revival.eval.mjs` (dev_reducers tripwire) — NOT at risk.** Its
  `devReducerRevivalStatus` reads ONLY `.github/workflows/*` + spec/test sources; it
  does NOT read the justfile, `scripts/verify-*`, or `docs/`. Its trigger is a
  workflow line with `--features` + `dev_reducers`. pt-a2 touches NO workflow, and the
  honest publish AVOIDS `--features dev_reducers` (default publish). Dormant/green.
- **`nightly-smoke-wiring.eval.mjs`** — reads the justfile but only the
  `lint`/`coverage`/`mutate-server`/`smoke-republish` recipes + workflow files. New
  `playtest-*` recipes don't affect its name-targeted predicates. `ci:` unchanged.
  GREEN.
- **`build-ci-hygiene.eval.mjs`** — checks `lint` recipe body, SHA-pins, `engines`,
  devcontainer, biome. NONE touched. Its `extractRecipeBody` is REUSED (imported, not
  modified) by the new eval. GREEN.
- **`dom-shell-coverage-exclusion.eval.mjs`** — rejects `coverage.exclude` entries
  outside DOM_SHELLS + requires `include: ['src/**/*.ts']`. pt-a2 touches NO
  `client/vite.config.ts` coverage block and adds NO client `src` file → not scanned.
  `client/dist/**` already gitignored + biome-excluded (`!client/dist`), so a runtime
  build artifact won't trip `biome check .`. GREEN. (This is why T2 reads `dist` at
  runtime and adds nothing to any exclude list.)
- **`gate-hardening-config.eval.mjs`** — requires `allowOnly: false` in
  vite.config.ts; untouched. GREEN.
- **New-eval hygiene:** the new `*.eval.mjs` must be Semgrep/biome-clean: NO `new
  RegExp`; literal patterns + `String.includes`/`indexOf`/`startsWith`; default-export
  `{ name, pass, detail }`; proof-of-teeth-first ordering (can't be vacuously green).

## H) Anti-patterns to avoid

- Source-grep for `dev_reducers` instead of introspecting the published module (the
  spec's central risk). The checker MUST consume `spacetime describe --json
  monster-realm-playtest`, not `server-module/src`.
- Bare-substring hook fingerprint (`bundle.includes('__mrPvp')`) — false-flags dead
  object literals + source-map comments an unminified build retains (ADR-0128 §D3).
  Fingerprint = the `window`-binding assignment form.
- Dynamic `new RegExp(...)` anywhere — Semgrep `detect-non-literal-regexp` (3× bites).
  Literal patterns + String methods only. Also watch `execFileSync`/child_process
  Semgrep rules — run `semgrep scan --config auto --error --exclude '.claude'` locally
  before the PR (SAST is a remote-only gate; bit pt-a1 twice); `execFileSync` (array
  args, no shell) is preferred over `execSync` (string).
- Publishing to the dev-default `monster-realm` — reject-not-clamp guard in recipes;
  default is `monster-realm-playtest`.
- `scripts/playtest-*.sh` (orchestration outside the `verify-*` touch-set) — keep
  orchestration in justfile bodies; `scripts/` holds only `verify-*`.
- Adding `playtest-*` recipes to `just ci` — they need a live instance / real `dist`.
- Hand-editing `CHANGELOG.md` (git-cliff) / `docs/adr/README.md` (supervisor-owned) /
  the ADR index; picking an ADR number other than 0129.
- Touching `client/vite.config.ts` coverage/`test` block or adding a
  `coverage.exclude` entry — trips `dom-shell-coverage-exclusion`. pt-a2 needs no
  client-config change.
- Running the live CLI/FS driver at eval import time — use the `import.meta.url ===
  pathToFileURL(process.argv[1]).href` main-guard.
- A wrapping JSON array on `spacetime call` args (double-nests → server rejects,
  ADR-0088) — call `sync_content` with no wrapping, per `smoke-republish.sh`.

## I) Final `touches:` + `touches-delta:`

**`touches:`**
- `justfile` (STRUCTURAL; +~5 recipes: `playtest-up`, `playtest-down`,
  `playtest-verify-release`, `playtest-verify-build`, `playtest-wipe`)
- `scripts/verify-release-reducers.mjs` (NEW)
- `scripts/verify-build-hooks.mjs` (NEW)
- `docs/playtest-ops.md` (NEW)
- `docs/adr/0129-pt-a2-local-playtest-ops.md` (NEW — reserved 0129)
- `docs/specs/pt-a2-plan.md` (this plan)
- `ARCHITECTURE.md` (minimal targeted addition)

**`touches-delta:` (deliberate — justify in PR body)**
- `evals/playtest-verify.eval.mjs` (NEW auto-discovered eval — the CI-gated
  proof-of-teeth home; outside the literal declared set but SAFE because the slice is
  SERIAL and no concurrent sibling owns `evals/**`; `evals/run.mjs` NOT touched).

**Explicitly NOT touched:** `client/**` (no vite/package change); `server-module/**`,
`game-core/**`, `docs/knowledge/**`; `.github/workflows/**` (nightly job deferred to
pt-a3); `CHANGELOG.md`, `docs/adr/README.md`, `evals/run.mjs`; no lockfiles.

## J) Exact CLI commands (for the recipes)

Env defaults: `STDB_SERVER=${STDB_SERVER:-http://127.0.0.1:3000}`,
`MR_PLAYTEST_DB=${MR_PLAYTEST_DB:-monster-realm-playtest}`.

- **playtest-up:**
  1. Guard: fail if `$MR_PLAYTEST_DB` == `monster-realm`.
  2. `spacetime build --module-path server-module`
  3. `spacetime publish -s "$STDB_SERVER" --module-path server-module -y "$MR_PLAYTEST_DB"` (honest default; no `--features`/`--bin-path`; no `--delete-data` so existing session data survives per ADR-0006)
  4. `spacetime call -s "$STDB_SERVER" "$MR_PLAYTEST_DB" sync_content`
  5. `node scripts/verify-release-reducers.mjs` (→ `spacetime describe --json`; exit 1 on any of `start_wild_battle`/`grant_bait`/`grant_item`)
  6. `cd client && npx vite build`
  7. `node scripts/verify-build-hooks.mjs` (→ scans `client/dist/**/*.js`; exit 1 on any `.__game=`/`.__mrTrade=`/`.__mrPvp=` binding)
  8. `cd client && npx vite preview` (static-serve the production build)
- **playtest-down:** stop the preview process; data/module persist.
- **playtest-verify-release:** `node scripts/verify-release-reducers.mjs`
- **playtest-verify-build:** `node scripts/verify-build-hooks.mjs`
- **playtest-wipe:** guard DB ≠ `monster-realm` → `spacetime publish -s "$STDB_SERVER" --module-path server-module --delete-data -y "$MR_PLAYTEST_DB"` → `spacetime call -s "$STDB_SERVER" "$MR_PLAYTEST_DB" sync_content`.
- **"which build am I on":** read `window.__mrBuild` / `#build-stamp` in the served client (ADR-0128); confirm DB via `spacetime sql -s "$STDB_SERVER" "$MR_PLAYTEST_DB" "SELECT content_version FROM config"` and that the connected DB name is `monster-realm-playtest`.

## K) Review reconciliation (reviewer + red-team findings folded — AUTHORITATIVE; overrides earlier text on conflict)

The plan-review lenses (reviewer + red-team) surfaced 3 BLOCKERs, 4 HIGHs, and
several MEDIUM/LOW. All are folded here. Where this section conflicts with §A–J,
**this section wins** — the tester encodes each as a biting tooth; the implementer
implements to it.

### Corrected forbidden-reducer set (red-team F1 — BLOCKER, factual)
- `forbiddenNames = ['start_wild_battle', 'grant_bait']` — EXACTLY two.
  `grant_item` is a `pub(crate) fn` helper (inventory.rs:31), never a reducer;
  including it guards a surface that cannot exist. TOOTH: assert `forbiddenNames`
  has exactly 2 entries; a describe blob containing `"grant_item"` only in a
  NON-reducer field must return `[]` (exact-name match on reducer entries, not a
  blob-wide substring — else `grant_item` in a doc-string would false-flag). ADR-0129
  notes: "if a callable `grant_item` reducer is ever introduced, add it here."

### pt-a2-3 fail-loud on empty/error/no-reducers (reviewer B-1 + H-2, red-team F2/F8 — BLOCKER)
The guard must NEVER be green when the introspection itself failed. Design:
- Pure `parseReducerNames(describeOutput) -> string[]`: `JSON.parse`; walk the
  reducer list. **THROWS** (`Error`) on: empty/whitespace-only input; `JSON.parse`
  failure; or a parsed structure yielding ZERO reducer names (a published module
  ALWAYS has `join_game`/`sync_content`, so zero ⇒ wrong JSON path or failed
  introspection). Robust path-walk: try known candidate paths and, if the structure
  is unexpected, fall back to scanning for reducer-typed entries — but STILL throw if
  the final list is empty. **Confirm the exact 2.6.0 `describe --json` reducer path
  empirically against a live instance during impl** (the implementer starts a local
  instance, publishes `monster-realm-playtest`, captures the real JSON, and pins the
  path + adds a real-shaped fixture).
- Pure `findForbiddenReducers(reducerNames: string[], forbidden) -> string[]`:
  exact-name membership; returns offenders.
- Driver (main-guarded): `try { out = execFileSync('spacetime', ['describe','--json','-s',server,db], {encoding:'utf8'}) } catch(e){ console.error(...); process.exit(1) }`
  → `names = parseReducerNames(out)` (throw ⇒ uncaught ⇒ non-zero exit, but WRAP to
  print a clear diagnostic + `process.exit(1)`) → `offenders = findForbiddenReducers(names, forbidden)`
  → `process.exit(offenders.length ? 1 : 0)`.
- TEETH: `parseReducerNames('')` THROWS; `parseReducerNames('{"tables":[]}')` (valid
  JSON, no reducer key ⇒ zero names) THROWS; a nested `{"schema":{"reducers":[...]}}`
  fixture AND a flat `{"reducers":[...]}` fixture BOTH parse to a non-empty list
  (path robustness, F8); GOOD production-reducer fixture ⇒ `findForbiddenReducers`
  returns `[]`; each of `start_wild_battle`/`grant_bait` present ⇒ offender.
  Structural tooth: source-scan `verify-release-reducers.mjs` requires a
  `process.exit(1)` in the `execFileSync` catch AND the empty-output/throw path.

### pt-a2-4 fail-loud on absent/empty dist + fingerprint additions (reviewer B-2, red-team F3/F4/F9 — BLOCKER/HIGH)
- Driver MUST fail loud when `client/dist` is absent OR contains zero `.js` files —
  `process.exit(1)` with "run `just playtest-up` / `vite build` first" (else scanning
  an empty concat is vacuously green, F3). TOOTH: source-scan
  `verify-build-hooks.mjs` requires a no-JS-files / dist-absent branch that
  `process.exit(1)` BEFORE (or when) calling `findDevHooks`.
- Fingerprint set (whitespace-normalized `String.includes`, NO regex):
  `.__game=` / `.__game =`, `.__mrTrade=` / `.__mrTrade =`, `.__mrPvp=` / `.__mrPvp =`
  (the `.` prefix also catches `globalThis.`/`self.`/`w.` receivers — L1),
  PLUS the defineProperty escape: `defineProperty(window,"__game"` /
  `defineProperty(window,'__game'` and the `__mrTrade`/`__mrPvp` analogues (red-team
  F4). **DROP the bracket-assignment `["__game"]` variants** (M2 false-positive risk;
  vite build emits no sourcemaps by default so bracket forms aren't reachable).
- TEETH: BAD = `window.__mrPvp = function(){}`, `w.__game=1`,
  `Object.defineProperty(window,"__mrPvp",{value:fn})` ⇒ each flagged. GOOD-clean =
  minified bundle w/ none ⇒ `[]`. Anti-FP GOOD (MUST pass): dead object literal
  `{challengePvp:()=>{},proposeTrade:()=>{}}` + bare tokens `__mrPvp`/`__game` (no
  `.`-binding) ⇒ `[]`; AND `window.__mrBuild = {sha:'abc'}` ⇒ `[]` (the ungated prod
  stamp must NOT be flagged — guards against accidental `.__mr*` broadening, F9).
- ADR-0129 acknowledges the residual: a defineProperty with a RENAMED receiver
  (`defineProperty(w,"__mrPvp"`) is not caught by the `defineProperty(window,` form;
  it is not emitted by the current build (ADR-0128 §D3 DCE) and is backstopped by
  pt-a1's source-level `main.wiring.test.ts` (which catches the source `window.__x`
  form regardless of bundler emit shape).

### pt-a2-2 playtest-down concrete mechanism (reviewer H-1 — HIGH)
`playtest-up` backgrounds the preview with a PID file so `playtest-down` can stop it:
- `playtest-up` final step: `( cd client && client/node_modules/.bin/vite preview ) & echo $! > "${TMPDIR:-/tmp}/mr-playtest-preview.pid"` (or `setsid` for full
  detach), print the served URL. Use the LOCAL vite binary, not `npx` (N3).
- `playtest-down`: `kill "$(cat "${TMPDIR:-/tmp}/mr-playtest-preview.pid")" 2>/dev/null || true; rm -f "${TMPDIR:-/tmp}/mr-playtest-preview.pid"`; document that the
  module + data PERSIST (wipe with `playtest-wipe`). PID file lives in `$TMPDIR`
  (no repo artifact, no `.gitignore` touch).
- TEETH: `playtest-up` body contains a preview + pid-file write; `playtest-down` body
  contains `kill` + the pid-file path.

### Recipe hardening (reviewer M-1/M-3/M-4/L-2/L-3/N-1/N-3, red-team F5/F6 — HIGH/MED)
- **Case-insensitive default-DB guard (red-team F6 — HIGH):** guard uses bash
  lowercase fold `if [ "${MR_PLAYTEST_DB,,}" = "monster-realm" ]; then …fail…` in
  BOTH `playtest-up` and `playtest-wipe`. TOOTH: recipe body contains the lowercase
  fold token (`,,}`); a BAD fixture with a case-sensitive-only guard is rejected.
- **Whole-justfile forbidden-flag scan (red-team F5 — HIGH):** the eval scans the
  ENTIRE comment-stripped justfile text (not just recipe bodies) and FAILS if
  `dev_reducers` or `--bin-path` appears anywhere (catches a `just` variable
  `EXTRA := "--features dev_reducers"` substituted into a recipe). Since the honest
  publish never uses either, their total absence is the invariant.
- **`playtest-wipe` also runs `playtest-verify-release`** after republish (reviewer
  M-4) — wipe republishes the module, so it must re-prove dev_reducers-absent. TOOTH:
  `playtest-wipe` body invokes `just playtest-verify-release`.
- **`set -euo pipefail` per bash recipe (reviewer M-1):** TOOTH — each new
  bash-shebang recipe body contains `set -euo pipefail`.
- **Exact-step (not substring) recipe→script references (reviewer L-2):** the
  recipe-references-script teeth require a trimmed body line EQUAL to
  `node scripts/verify-release-reducers.mjs` / `node scripts/verify-build-hooks.mjs`
  / `just playtest-verify-release` (mirrors `nightly-smoke-wiring` TEETH F6) — a
  `|| true` suffix must NOT satisfy it.
- **`sync_content` output-checked (reviewer L-3):** reuse the smoke-republish pattern
  `if ! SYNC_OUT=$(spacetime call … sync_content 2>&1); then fail; fi` + grep the
  output for `err`/`rejected`/`unauthorized` (fail loud) — the owner-re-register path
  after `--delete-data` can surface `unauthorized`.
- **Client build via `npm run build` (N3):** `cd client && npm run build` (the
  package.json `"build": "vite build"` — same binary path as CI), then preview via
  the local binary. Not `npx`.
- **Explicit `spacetime build` pre-step comment (M-3/N-1):** `playtest-up` keeps the
  explicit `spacetime build` before `publish` (surfaces compile errors before network
  contact — matches smoke-republish); a one-line comment says so. `playtest-wipe` has
  no separate build step (publish rebuilds) — a one-line comment notes the asymmetry
  is intentional.

### Semgrep (red-team F10 / reviewer): run `semgrep scan --config auto --error --exclude '.claude'` LOCALLY before the PR
`execFileSync` (array args, no shell) is the safest child-process form; if the auto
ruleset still flags it, add a correctly-scoped `// nosemgrep: <doubled-rule-id>` per
pt-a1's learning (bare `// nosemgrep: <rule>` silently no-ops — needs the doubled
last segment). SAST is remote-only; catch it locally.
