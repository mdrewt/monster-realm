# ADR-0128 — Client-side local-playtest build hygiene: prod-safe connection config + build version stamp

**Status:** Accepted
**Date:** 2026-07-19
**Slice:** pt-a1
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui, security-authz, ci-gates

**Decision:** Production client build fails loud on the dev-default DB `monster-realm` (DB not URI); every build carries an ungated git-SHA/time `BUILD_INFO` (`window.__mrBuild`) for the F9 bundle; ADR-0127 DEV hooks absent from the minified build.

---

## Context

The playtest-first replan (2026-07, rescoped 2026-07-17 to **local-only, solo tester**) requires an
*honest* local playtest build before the fun gate: the dev loop (local SpacetimeDB @ `127.0.0.1:3000`
+ `vite` dev server) is not a playtest build. `M-playtest-a` (sketch) owns this; **pt-a1** is its first
sub-slice — the client-side build hygiene. The slicing pass (`docs/specs/pt-a1-plan.md`) reconciled the
sketch against `master` b31eeab (M17.5 closed) and found two of the three client deliverables already
partly landed:

- **Env-driven config already exists** (`main.ts:77-78`): `VITE_STDB_URI`/`VITE_STDB_DB` with
  dev-default fallbacks, consumed at `connect({ uri, db })`. But nothing stops a *production* build from
  silently connecting to the dev-default DB `monster-realm`, which would corrupt the very H1/H2/H3
  feedback the playtest exists to gather — and there were no tests.
- **The `__game`/`__mrTrade`/`__mrPvp` DEV hooks are already gated** behind `if (import.meta.env.DEV)`
  (ADR-0127 / m17.5f). pt-a1 must **reconcile/verify**, not re-implement. ADR-0127 flagged a
  `--minify false` caveat.
- **No build version stamp exists** — the net-new work. The M-playtest-b **F9 bug-report bundle**
  embeds "build SHA (M-playtest-a stamp)" to pin which build a finding came from across wipe/republish.

## Decision

### D1 — Prod-safe connection config: fail loud on the dev-default DB (reject-not-clamp)

Extract a pure `resolveConnectionConfig({ uri?, db?, isDev }) → { uri, db }`
(`client/src/net/connectionConfig.ts`). It **trims** both inputs. In dev (`isDev === true`) it preserves
today's behavior exactly (`ws://127.0.0.1:3000` / `monster-realm` fallbacks). In a **production build**
(`isDev === false`), if the trimmed `VITE_STDB_DB` is **unset, empty, whitespace-only, or
case-insensitively equals** the dev-default `'monster-realm'`, it **throws** a descriptive error naming
`VITE_STDB_DB` — it does not clamp to a "safe" default (parse-don't-validate; reject-not-clamp at the
boundary). The empty/whitespace/case handling closes the bypasses a bare `=== 'monster-realm'` check
would leave (a red-team pass found `''`, `' monster-realm '`, and `'Monster-Realm'` all slip past an
exact-equality guard). The comparison is EXACT on the rest of the name (not a prefix) so a legitimately
different DB like `monster-realm-old` is allowed. This is what stops an honest playtest build from
silently pointing at the dev database.

The wiring keeps the resolve at **module top level** in `main.ts` (equivalent eager eval to today's
`const URI/DB`), so a misconfigured prod build throws at module-evaluation time — before `connect()` is
reachable. A `main.wiring.test.ts` source-scan gates this placement (the throw is only load-bearing if
it fires at module scope, not inside `main()` where a try/catch could swallow it). For a solo local
tester, a module-eval throw surfaces as a blank page + a descriptive console error (acceptable — it is a
build-time misconfiguration, not a runtime user condition).

**Guard the DB name, NOT the URI.** `ws://127.0.0.1:3000` is the *legitimate* topology for a local-only
playtest (replan §4). The DB name is the data-corruption vector (wrong DB = wrong data written to the
wrong place); the URI is not. Guarding the URI would false-reject the real local playtest setup, so the
URI keeps its localhost fallback in both dev and prod. When external testers arrive
(M-playtest-a2, hosted), the publish path sets `VITE_STDB_URI` explicitly; that milestone can revisit a
URI guard if warranted.

The resolve stays at module top level (equivalent eager evaluation to today's `const URI/DB`), so a
misconfigured production build fails loud at load — the desired behavior for a build-time
misconfiguration.

### D2 — Build version stamp: ungated `BUILD_INFO`, deliberately contrasting the DEV hooks

`client/vite.config.ts` injects two build-time constants via `define`: `__MR_BUILD_SHA__`
(env `MR_BUILD_SHA` override → `git rev-parse --short HEAD` → `'unknown'` on failure) and
`__MR_BUILD_TIME__` (env `MR_BUILD_TIME` override → `new Date().toISOString()`). A pure
`client/src/net/buildInfo.ts` exposes `BuildInfo { sha, builtAt, mode }` via
`buildInfoFrom(sha, builtAt, isDev)` (pure, tested) and `formatBuildStamp(info)` (pure, tested), with a
single impure line assembling `BUILD_INFO` from the injected globals + `import.meta.env.DEV`. The stamp
renders into a non-intrusive `#build-stamp` corner element and is exposed at `window.__mrBuild`.

**`window.__mrBuild` is UNGATED** — present in production, the deliberate opposite of the DEV-gated
`__game`/`__mrTrade`/`__mrPvp` debug hooks. Rationale: the M-playtest-b F9 bug bundle runs *in the
production playtest build*; it must be able to read the build provenance. The stamp exposes only
non-secret build metadata (a short SHA + a timestamp), so there is no privilege or data-leak concern
(contrast the debug hooks, which dispatch reducers). The injected SHA is env-overridable so the deferred
hosted-publish path (M-playtest-a2) can stamp its own provenance.

### D3 — DEV-hooks-absent: empirical reconciliation + precision refinement of ADR-0127's caveat

pt-a1 does not re-implement the DEV gating. It records the empirical verification (run during the
slicing pass on `master` b31eeab, and re-verified post-implementation):

- **Default minified `vite build`** → `dist/assets/index-*.js`; grep for the window-binding
  fingerprints `__game` / `__mrTrade` / `__mrPvp` → **0 matches**. The `if (import.meta.env.DEV)` guard
  is define-replaced to `if (false)` and stripped. This is the honest playtest build.
- **`vite build --minify false`** → **also 0** `window.__*` bindings. The dead `if (false)` window
  assignments are eliminated by **Rollup's DCE**, which runs independent of minification; only the
  (now unreferenced, unreachable) hook *object literals* linger in the unminified bundle. So the
  security-relevant surface — the `window.__*` binding a tester/attacker could reach — is gone even
  unminified; minification additionally strips the dead literals for a clean bundle. **This refines
  ADR-0127's `--minify false` caveat** (which implied the hooks are "retained"): the reachable binding
  is not retained; only dead object literals are. Not a reversal — the honest build is still the
  default minified one, and pt-a1 keeps the gate.

**A cheap source-level regression guard ships IN pt-a1; only the build-artifact guard is deferred.**
A `main.wiring.test.ts` source-scan asserts the `.__game`/`.__mrTrade`/`.__mrPvp` window assignments
stay inside the `if (import.meta.env.DEV)` gate (and does not flag the intentionally-ungated
`window.__mrBuild`). This is a vitest source-scan (NOT an eval — `evals/run.mjs` is off-limits to pt-a1)
and it bites the two source-level regressions a red-team pass flagged: a new hook added ungated, or the
gate swapped to `process.env.NODE_ENV` (which Vite does not define-replace the same way, so DCE would
not fire). The remaining guard — a real `vite build` + grep of the artifact, which alone catches a
committed `--minify false` — is deferred to **pt-a2**, alongside its mechanical release-verification
(the `dev_reducers`-absent proof against the published module), where a `scripts/verify-*` + `justfile`
home exists. pt-a1's proof-of-teeth are the config fail-loud tests, the build-stamp formatter tests, and
the two `main.wiring` source-scans; the minified-artifact property is verified empirically (§D3) and
documented here.

## Consequences

- A production playtest build cannot silently write to the dev database — the single most important
  integrity protection for the playtest feedback the gate depends on.
- Every playtest build is self-identifying; a tester's F9 bundle pins the exact build, surviving
  wipe/republish cycles.
- Rules stay in pure, unit-tested cores (`connectionConfig.ts`, `buildInfo.ts`); the `main.ts` /
  `index.html` wiring is thin imperative shell (coverage-excluded).
- `vite.config.ts` gains a `define` block; the `test`/`coverage` blocks are untouched, so the
  `dom-shell-coverage-exclusion` and `gate-hardening-config` evals stay green (the new pure modules are
  coverage-MEASURED, not excluded).

## Alternatives considered

- **Clamp a bad prod DB to a safe default** instead of throwing — rejected: silent correction hides the
  misconfiguration and could still write to an unintended DB; fail-loud is the honest boundary.
- **Guard the URI too** — rejected: localhost is the legitimate local-playtest URI; guarding it
  false-rejects the real topology (D1).
- **DEV-gate the build stamp** like the debug hooks — rejected: the F9 consumer runs in production and
  needs it; the stamp carries no secret (D2).
- **A `vite-env.d.ts` for the injected globals** — rejected in favor of a module-scoped `declare const`
  co-located in `buildInfo.ts` (only that file references them), avoiding a touches-delta.
- **An automated build-output grep eval/test now** — deferred to pt-a2 (D3): cost exceeds the drift
  risk for pt-a1, and `evals/run.mjs` is off-limits.

## Residuals / known limitations (from the red-team plan pass)

- **`BUILD_INFO` fallback branch is unit-untestable** (F-4). The `typeof __MR_BUILD_SHA__ !== 'undefined'
  ? … : 'unknown'` branch is dead under vitest (the `define` always fires, so the token is a string
  literal). The `'unknown'` path is instead covered by `buildInfoFrom('unknown', …)` at the formatter
  level plus the empirical build; the module-const init expression's fallback is not branch-tested. The
  top-level `define` also applies under vitest (verified empirically — importing `buildInfo.ts` never
  crashes and the suite is green), and `typeof` on an undeclared global is safe in JS (returns
  `'undefined'`, never throws), so the import is robust even if the define did not fire.
- **Hosted-build SHA enumeration** (F-6). `window.__mrBuild.sha` is a short git SHA. Harmless for the
  local-only playtest (the tester is the developer). When M-playtest-a2 (hosted) ships against a
  still-private repo, the publish path SHOULD set `MR_BUILD_SHA` to a non-enumerable identifier (a
  deploy UUID/counter) rather than the raw SHA. The env override already supports this.
- **Build-time non-determinism in tests** (F-7). `new Date().toISOString()` in the `vite.config.ts`
  define differs per run, so `BUILD_INFO.builtAt` is non-deterministic. Tests MUST assert via
  `buildInfoFrom(sha, builtAt, isDev)` with literal params (never import `BUILD_INFO` for a value
  assertion); `MR_BUILD_TIME` can pin it if a future integration test needs a stable stamp. The exact
  `BuildInfo` shape `{sha, builtAt, mode}` is pinned by `buildInfo.test.ts` B1e/B1f `toEqual` — so a
  future added field (which could leak via the ungated `window.__mrBuild`) fails those tests first
  (closes the impl reviewer's H-1 concern about the ungated surface).

The impl red-team pass (26 attacks) confirmed all F-1..F-7 closed and found two LOW residuals — both
documented-not-fixed because there is **no untrusted-input path** in either topology (local-only: the
operator is the developer; hosted M-playtest-a2: the build env is the deploy pipeline, not testers):

- **Zero-width-char evasion of the DB guard** (LOW-1). `String.prototype.trim()` does not strip
  `U+200B`/`U+200C`/`U+200D`/`U+FEFF` (Unicode Cf, not whitespace), so a `VITE_STDB_DB` of
  `monster-realm` with a trailing zero-width space (`U+200B`) passes the dev-default guard. Exploitable ONLY if
  SpacetimeDB normalizes the name by stripping the char (unconfirmed; a strict STDB rejects it =
  fail-loud anyway) AND an adversary controls the build env (they don't, per above). The guard already
  rejects all realistic vectors (unset/empty/whitespace/newline/tab/NBSP/case/null). Fix, if ever
  needed: strip the `U+200B`..`U+200D` and `U+FEFF` characters before the guard, or reject non-ASCII DB names (a policy call
  deferred — could false-reject a future i18n name). Slated for pt-a2's mechanical release-verification
  if it lands a DB-name policy.
- **F-5 source-scan single-DEV-block assumption** (LOW-2). The `main.wiring.test.ts` F-5 gate anchors on
  the FIRST `if (import.meta.env.DEV)`; a future SECOND DEV block with an ungated hook between the two
  could evade the before-gate slice. Non-exploitable today (exactly one DEV block); flagged for the next
  editor's awareness (visible in the test comments).
