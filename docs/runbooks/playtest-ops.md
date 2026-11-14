# Runbook: local playtest operations

How to publish, serve, reset and identify a local playtest build. A playtest build is
the default release module (no `dev_reducers`) published to an isolated database,
plus the production client bundle (no DEV debug hooks). Every recipe here is in the
`justfile`.

## Prerequisites

- The `spacetime` CLI 2.11.0 on PATH and a running server. Start one in its own
  terminal, bound to loopback (the metrics endpoint is unauthenticated):
  `spacetime start --listen-addr 127.0.0.1:3000`.
- `just setup` (client dependencies) and `just wasm` (the prediction wasm package the
  client build imports). In a fresh checkout, the client build fails without both.
- GNU `timeout` on PATH (macOS: `brew install coreutils`), which the preflight uses.

Environment overrides:

| Variable | Default | Meaning |
|---|---|---|
| `STDB_SERVER` | `http://127.0.0.1:3000` | Server URL for every recipe below |
| `MR_PLAYTEST_DB` | `monster-realm-playtest` | Database name; the recipes refuse `monster-realm` (the dev database), in any letter case |

## `just playtest-preflight`

Checks that the `spacetime` CLI and `timeout` exist, then runs
`timeout 10 spacetime server ping "$STDB_SERVER"` and requires its `Server is online`
line. It exits 1 with a one-line pointer to `spacetime start` when no server answers.
`playtest-up` and `playtest-wipe` run it first; `playtest-verify-release` and
`playtest-report` do not.

## `just playtest-up`

1. Refuses a dev-default `MR_PLAYTEST_DB`, then runs the preflight.
2. `spacetime build --module-path server-module`.
3. `spacetime publish -s "$STDB_SERVER" --module-path server-module -y "$MR_PLAYTEST_DB"`,
   with no features and no `--delete-data`, so existing data survives.
4. `spacetime call ... sync_content`, failing if the output says rejected or
   unauthorized. Only the identity that first published the database (its owner) may
   call it.
5. `just playtest-verify-release`, then the production client build with
   `VITE_STDB_DB="$MR_PLAYTEST_DB"` (the build writes `client/dist/shell-config.js`, the
   shell document naming the playtest database), then `just playtest-verify-build`.
6. Starts `vite preview` in the background, records its PID in
   `${TMPDIR:-/tmp}/mr-playtest-preview.pid`, and prints the URL (by default
   `http://localhost:4173`).

The built client joins the address in `client/dist/shell-config.js`: `ws://127.0.0.1:3000`
unless `VITE_STDB_URI` is set for the build. To serve the build against another SpacetimeDB
address, set `VITE_STDB_URI` for the build, or replace `client/dist/shell-config.js` after it.
`just playtest-verify-build` checks the database name only, not the address. Returning players
keep their identity only if the `uri` and `db` strings are spelled exactly as before: their
stored token is keyed on those strings.

Re-running it republishes and re-syncs content without a wipe. Run
`just playtest-down` first if a preview is already running: a second `playtest-up`
overwrites the PID file, and the first preview then has to be stopped by hand.

A republish that adds a column to a table clients subscribe to disconnects every
connected client (the CLI prints "All clients will be disconnected due to breaking
schema changes"). A client bundle built before the column existed then reconnects but
cannot decode the rows: it never joins and shows no error, only uncaught exceptions in
the console. Publish the module and serve the matching client build together, and have
players reload.

The module publishes each player's movement acknowledgement on `character.acked_seq`,
written by `movement_tick`; `player.last_input_seq` stays 0. The served client must be a
build that reads `character.ackedSeq`. Publishing the module alone is safe for such a
client: `move_intent` is a private table, so adding it changes no row a client decodes.

A publish can fail with "Aborting because publishing would require manual migration or
deletion of data". This happens when the database holds a schema the automatic
migration cannot convert, for example a database published by an older SpacetimeDB
whose enum variants were renamed. That database needs `just playtest-wipe`, which
destroys its data, or a different `MR_PLAYTEST_DB`.

## `just playtest-down`

Stops the preview recorded in the PID file and deletes the file. The module and its
data persist.

## `just playtest-verify-release`

Runs `node scripts/verify-release-reducers.mjs`, which reads the published module with
`spacetime describe --json "$MR_PLAYTEST_DB"` and fails if `start_wild_battle` or
`grant_bait` is present, or if the introspection failed or found no reducers at all.
It checks what was published, not the source tree. Output on success:
`verify-release-reducers: OK — <N> reducer(s) in published module "<db>"; no dev reducers …`.

## `just playtest-verify-build`

Runs `node scripts/verify-build-hooks.mjs`, which scans `client/dist/**/*.js` for a
DEV hook binding (`__game`, `__mrTrade`, `__mrPvp`, `__mrTactics`). It fails if one is
present, or if `client/dist` is missing or contains no `.js` bundle. It also fails if
`MR_PLAYTEST_DB` is empty or `monster-realm`. It then requires that `shell-config.js` exists,
that running it (in a time-bounded `node:vm` context) sets a readable `__MR_SHELL_CONFIG__`
with a string `connection.db`, and that this `db` is exactly `MR_PLAYTEST_DB`. It fails if any
other file in the build contains the `MR_PLAYTEST_DB` name (a name elsewhere is an address
baked back into the build, which a host could not change), or if `index.html` does not load
`/shell-config.js` from a classic `<script>` tag (outside comments, without `async`, `defer`,
`nomodule` or `type`). Run on its own, it therefore needs the same `MR_PLAYTEST_DB` the build
used. Success prints `verify-build-hooks: OK — …`.

## `just playtest-wipe` (destructive)

Refuses the dev database, runs the preflight, republishes with `--delete-data -y`
(every row in `$MR_PLAYTEST_DB` is lost), calls `sync_content`, and re-runs
`playtest-verify-release`. `--delete-data` re-runs `init`, which makes the publishing
identity the owner again, so run it as the identity that should own the database.

The browser's stored token is issued by the server, not by the database, so after a
wipe the client reconnects as the same identity into the empty database, and
`join_game` creates a fresh character and starter monster. For a different identity,
close the tab.

## `just playtest-report`

Runs `node scripts/playtest-report.mjs`, which reads the private `playtest_event`
table over `spacetime` SQL and prints aggregate recruit rates only
(`weakenFirstRate`, `successRate`, `baitRate`, `recatchRate`), never identities.

## Identity and sessions

- The client keeps its token in the tab's `sessionStorage` (`net/authToken.ts`).
  A reload keeps the identity; a new tab or a closed tab means a new identity.
- A reload keeps monsters, inventory, currency, quests, profile and map position:
  disconnecting deletes the `player` and `character` rows and saves where the
  character stood, and `join_game` puts the new character there.
- A duplicated tab copies `sessionStorage`, so both tabs share one identity. The
  server resolves battles and trades only when the identity's last connection closes
  (`player_session` in `server-module/src/lib.rs`), so closing one of the two tabs no
  longer forfeits anything. Both tabs still drive the same character.
- If the server itself is reset (new data directory, a different `STDB_SERVER`), the
  stored token stops verifying. After two rejections the client connects anonymously
  once and stores the new token. A brief `Failed to verify token` status line during
  that is expected.

## Which build and database am I on?

- Client build: `window.__mrBuild` in the browser console, or the `#build-stamp`
  element, shows the git short SHA and build time. If it is stale, re-run
  `just playtest-up` and hard-reload.
- Database and content version:

  ```sh
  spacetime sql -s "$STDB_SERVER" "$MR_PLAYTEST_DB" "SELECT content_version FROM config"
  ```
