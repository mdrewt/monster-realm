# Playtest ops runbook (local, solo tester)

How to stand up, serve, reset, and identify an **honest** local playtest build of
Monster Realm. "Honest" = the DEFAULT release-profile server module (no
`dev_reducers`) published to an **isolated** DB, plus the production client build
(no `__game`/`__mrTrade`/`__mrPvp` DEV hooks). See ADR-0129 for the rationale and
ADR-0128 for the build-stamp / DEV-hooks reconciliation.

## Prerequisites

- A **local SpacetimeDB instance** running (default `http://127.0.0.1:3000`) and
  the `spacetime` CLI on PATH.
- `just setup` has been run so the client has its dependencies. A fresh worktree
  lacks `client/node_modules`, and `npm run build` fails with `vite: not found`
  until you run:

  ```sh
  just setup   # cargo fetch + (cd client && npm install --include=dev)
  ```

- Env overrides (both have safe defaults):
  - `STDB_SERVER` — SpacetimeDB server URL (default `http://127.0.0.1:3000`).
  - `MR_PLAYTEST_DB` — the isolated playtest DB name (default
    `monster-realm-playtest`). It must NOT be the dev-default `monster-realm`;
    the recipes reject that (case-insensitively).

## `just playtest-up` — publish + serve an honest build

Runs, in order:

1. **Guard** — refuse if `MR_PLAYTEST_DB` resolves to `monster-realm`.
2. `spacetime build --module-path server-module` — surfaces compile errors
   before any network contact.
3. `spacetime publish -s "$STDB_SERVER" --module-path server-module -y "$MR_PLAYTEST_DB"`
   — the honest DEFAULT publish (no `--features`, no `--bin-path`, no
   `--delete-data`, so existing session data survives per ADR-0006).
4. `spacetime call ... sync_content` — re-seeds content as the module owner
   (output-checked for `unauthorized`/`rejected`).
5. `just playtest-verify-release` — proves the PUBLISHED module has no dev
   reducers (see below).
6. `cd client && npm run build` — the production (minified) client build.
7. `just playtest-verify-build` — proves the built `client/dist` has no DEV hooks.
8. Serves the production build via `vite preview`, backgrounded under a PID file
   at `${TMPDIR:-/tmp}/mr-playtest-preview.pid`, and prints the served URL.

Re-running `playtest-up` is also the **republish-with-content-resync** path: it
republishes WITHOUT `--delete-data` (existing data survives, ADR-0006) and
re-runs `sync_content`, so a live content update is applied without a wipe.

## `just playtest-down` — end a session

Kills the backgrounded `vite preview` process (via the PID file) and removes the
PID file. The published **module and its data PERSIST** — use `just playtest-wipe`
for a fresh state.

> Run `playtest-down` before re-running `playtest-up` while a preview is already
> serving: a second `playtest-up` overwrites the PID file, leaving the first
> preview un-stoppable via `playtest-down` (kill it by port/`pkill vite` if that
> happens).

## `just playtest-verify-release` — dev-reducers-absent proof

`node scripts/verify-release-reducers.mjs` introspects the PUBLISHED module with
`spacetime describe --json "$MR_PLAYTEST_DB"` and fails loud (exit 1) if either
of the cfg-gated dev reducers `start_wild_battle` / `grant_bait` appears, OR if
the introspection itself failed / returned zero reducers (a published module
always has `join_game`/`sync_content`, so an empty parse means the check did not
run and must never read as green). It inspects the **published module, not the
source** — a wrong `--features`/`--bin-path` in the publish path is exactly the
failure this guards.

## `just playtest-verify-build` — DEV-hooks-absent proof

`node scripts/verify-build-hooks.mjs` scans `client/dist/**/*.js` and fails loud
(exit 1) if any DEV `window`-binding hook (`.__game=`/`.__mrTrade=`/`.__mrPvp=`,
or the `defineProperty(window,"__x"` escape) survives into the build. It uses the
binding form, not a bare token, so the dead object literals an unminified build
retains and the ungated `window.__mrBuild=` prod stamp are NOT flagged. It also
fails loud if `client/dist` is absent or has zero `.js` files (scanning nothing
must not read as green) — run `just playtest-up` / a vite build first.

## `just playtest-wipe` — wipe / reset to a fresh state

Republishes with `--delete-data -y` to `monster-realm-playtest`, re-runs
`sync_content`, and re-proves dev-reducers-absent (`just playtest-verify-release`)
because the module is rebuilt. There is no separate build step — `publish`
rebuilds.

**Owner re-register note (13.5c-4):** after `--delete-data`, the module's `init`
re-runs and the publishing identity is **re-registered as owner**. The
`sync_content` call MUST come from that owner identity, or it is rejected
(`unauthorized`). Run `playtest-wipe` from the same identity that published, and
the recipe's output check will fail loud if it is not.

## "Which build am I on?"

- **Client build:** in the served client, read `window.__mrBuild` in the console
  (or the `#build-stamp` element in the DOM) — it carries the build SHA + time
  stamped by vite at build (ADR-0128). If it is stale or absent, the browser is
  serving an old bundle; re-run `just playtest-up` and hard-reload.
- **DB name:** confirm you are connected to `monster-realm-playtest`, not the dev
  `monster-realm`. Cross-check the content version with:

  ```sh
  spacetime sql -s "$STDB_SERVER" "$MR_PLAYTEST_DB" "SELECT content_version FROM config"
  ```
