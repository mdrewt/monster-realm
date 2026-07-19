# ADR-0129 — Local playtest ops: honest release publish + published-module & build-output verification

**Status:** Accepted
**Date:** 2026-07-19
**Slice:** pt-a2
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, security-authz, tooling-docs

**Decision:** Playtest-ops recipes publish the default release module to isolated DB `monster-realm-playtest`; verifiers fail loud on dev_reducers in the published module (`describe`, not source) or DEV hooks in the dist; an eval gates the pure checkers.

---

## Context

The playtest-first replan (2026-07, rescoped to **local-only, solo tester**) needs a one-command
*honest* local playtest build before the fun gate. **pt-a1** (ADR-0128) delivered the client-side
build hygiene (prod-safe connection config, build stamp, DEV-hooks reconciliation) and explicitly
**parked** to pt-a2 (`docs/specs/pt-a1-plan.md` §F): the ops recipes, the mechanical
`dev_reducers`-absent release proof, the automated build-output DEV-hooks-absent guard, wipe/republish,
and the runbook. **pt-a2** discharges exactly that hand-off. See `docs/specs/pt-a2-plan.md` for the
full slicing pass (EARS pt-a2-1..-6, tasks, teeth, review reconciliation §K).

The dev loop (local SpacetimeDB + `vite` dev server) is not a playtest build: the cfg-gated dev
reducers (`start_wild_battle`, `grant_bait`) and the `import.meta.env.DEV`-gated
`__game`/`__mrTrade`/`__mrPvp` hooks would let the tester accidentally invalidate H1/H2 feedback, and
there is no reset ritual on an isolated DB. The spec's central risk: *"the `dev_reducers`-absent check
must inspect the published module (reducer list via CLI introspection), because a wrong feature flag in
the publish path is exactly the failure it guards."*

## Decision (details)

1. **Isolated DB + honest default publish.** `just playtest-up` publishes the DEFAULT release-profile
   module (`spacetime publish --module-path server-module`, no `--features`/`--bin-path`) to DB
   `monster-realm-playtest` (env `MR_PLAYTEST_DB`), calls `sync_content` (ADR-0006), runs the two
   verifiers, `npm run build`s the client, and serves it via `vite preview` (backgrounded under a
   `$TMPDIR` PID file so `playtest-down` can stop it). `playtest-wipe` republishes with `--delete-data`
   + `sync_content` + re-verify. spacetime 2.6.0 has **no cargo-feature passthrough** on `publish`
   (ADR-0054), so the default publish inherently OMITS the two dev reducers — the honest path is the
   *default* path, and the proof confirms it held.

2. **Reject-not-clamp DB guard (server-ops mirror of ADR-0128).** Publish/wipe recipes fail loud, via a
   **case-insensitive** bash fold (`${MR_PLAYTEST_DB,,}`), if the target DB resolves to the dev-default
   `monster-realm` — point-protection for the dev default only (the operator owns any other name; a
   `monster-realm-smoke` collision is out of scope, mirroring ADR-0128's client guard).

3. **Published-module proof, not source grep.** `scripts/verify-release-reducers.mjs` runs
   `spacetime describe --json <db>` (the `--json` form is **required** in 2.6.0) and fails loud if any
   of the cfg-gated reducers appears in the PUBLISHED reducer list. The forbidden set is exactly
   **`['start_wild_battle', 'grant_bait']`** — the only two functions carrying both
   `#[cfg(feature="dev_reducers")]` and `#[spacetimedb::reducer]`. **`grant_item` (inventory.rs) is a
   `pub(crate)` helper, not a reducer** — it can never surface in `describe`, so including it would guard
   a non-existent surface (removed on review). The verifier **fails loud when the introspection itself
   fails or returns zero reducers** (empty output, `describe` error, unexpected JSON path) — a published
   module always has `join_game`/`sync_content`, so an empty parse means the check did not actually run,
   which must never read as green (the mirror anti-pattern of source-grepping).

4. **Build-output DEV-hooks proof (parked from pt-a1 §F).** `scripts/verify-build-hooks.mjs` scans the
   emitted `client/dist/**/*.js` and fails loud on the DEV-hook **`window`-binding** fingerprints
   (`.__game=`/`.__mrTrade=`/`.__mrPvp=`, whitespace-normalized `String.includes`; the leading `.`
   also matches `w.`/`globalThis.`/`self.` receivers), plus the `Object.defineProperty(window,"__x"`
   escape. It uses the **binding form, not the bare token**: an unminified build legitimately retains
   dead object literals (`{challengePvp,proposeTrade}`) that are NOT attached to `window` (ADR-0128 §D3),
   and the ungated prod build stamp `window.__mrBuild=` must NOT be flagged. It fails loud if `dist` is
   absent or empty (scanning nothing must not read as green).

5. **Functional-core / imperative-shell + eval gate.** Each verifier = a PURE exported checker
   (`parseReducerNames`/`findForbiddenReducers`; `findDevHooks`) + a `pathToFileURL(process.argv[1])`
   **main-guarded** driver (the live CLI/FS I/O). `evals/playtest-verify.eval.mjs` (auto-discovered by
   `evals/run.mjs`) imports the pure checkers and asserts proof-of-teeth (BITE-on-bad, PASS-on-good,
   no-false-positive) plus structural scans of the recipes/scripts (isolated DB, no `--features
   dev_reducers`/`--bin-path` anywhere in the justfile, recipes invoke the verifiers, `set -euo
   pipefail`, dist-absent + describe-error guards present). This is the ONLY per-PR gate.

## Why the CI gate covers only the pure logic (no live instance in `just ci`)

`just ci` runs no live SpacetimeDB instance and no `vite build` — the live behaviors (real `describe`,
real dist) are the same class as `smoke-republish`/`e2e` (nightly/manual). So per-PR CI gates the
**detection logic + wiring** via the eval; the **live behavior** is gated by `just playtest-up` invoking
the verifiers against the real published module and real dist (the operator's local gate, self-verifying
before it serves). DoD = eval green in `just ci` + a documented, self-verifying `playtest-up`. A live
end-to-end nightly `playtest-smoke` (the pt-a2 analogue of the `smoke-republish` job) is deferred to
**pt-a3** (YAGNI for a solo local tester; would add a supervisor-owned nightly workflow job).

## Consequences / residual risks

- **Fingerprint residual (accepted):** a `defineProperty` with a *renamed* receiver
  (`defineProperty(w,"__mrPvp"`) is not caught by the `defineProperty(window,` form. It is not emitted by
  the current build (ADR-0128 §D3 — Rollup DCE strips the whole `if (false)` block) and is backstopped by
  pt-a1's source-level `main.wiring.test.ts` (which catches the source `window.__x` form regardless of how
  the bundler emits). If a future build tool changes DCE behavior, extend the fingerprint set + a tooth.
- **Guard-scope residual (accepted):** the DB guard protects only the literal dev-default
  `monster-realm`; other mistaken DB names are the operator's responsibility.
- **Semgrep:** `execFileSync` (array args, no shell) is the safest child-process form; the SAST gate is
  remote-only, so `semgrep scan --config auto --error --exclude '.claude'` is run locally before the PR
  (a correctly-scoped `// nosemgrep: <doubled-rule-id>` is added only if the auto ruleset still flags a
  legitimate line — a bare `// nosemgrep: <rule>` silently no-ops).
- Reuses ADR-0079's `smoke-republish.sh` CLI-shape lessons (each `spacetime call` arg is its own JSON
  value; `if ! VAR=$(cmd)` to keep `set -e`; output-check `sync_content` for `unauthorized`/`rejected`).

## Alternatives considered

- **Source-grep for `#[cfg(feature="dev_reducers")]`** — rejected: `dev-reducer-gating.eval.mjs` already
  gates the *source*; the new risk is a wrong flag in the *publish path*, which only published-module
  introspection catches.
- **A bash-only verifier** — rejected: a node `.mjs` with an exported pure checker is unit-gatable by the
  eval; bash cannot export a testable pure function.
- **Wiring the verifiers into `just ci`** — rejected: they need a live instance + real dist; they would
  red every PR (same reason `smoke-republish` is nightly-only).
