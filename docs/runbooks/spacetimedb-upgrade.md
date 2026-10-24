# Runbook: upgrading SpacetimeDB

How to move the SpacetimeDB CLI, host and module crate to a new version. The current
pin is 2.11.0. The rule behind this runbook is in `docs/DECISIONS.md` ("SpacetimeDB
versions move in lockstep").

## What moves together

| Pin | Where |
|---|---|
| Rust `spacetimedb` crate | root `Cargo.toml` (`[workspace.dependencies]`) |
| CLI/host used by CI | `.github/workflows/ci.yml`, two `Pin spacetime <ver>` steps (`spacetime version install <ver>` + `spacetime version use <ver>`) |
| CLI/host used nightly | `.github/workflows/nightly.yml`, one `Pin spacetime <ver>` step |
| Local CLI | `spacetime version install <ver>` then `spacetime version use <ver>`; check with `spacetime --version` |
| Generated TypeScript bindings | `client/src/module_bindings/` (regenerated, never hand-edited) |

The npm `spacetimedb` SDK (`client/package.json`, locked in
`client/package-lock.json`) joined the lockstep on 2026-10-15 (see the amended
decision in `docs/DECISIONS.md`): since 2.7.0 the vendor ships CLI/crate/SDK from one
monorepo on the same day with no documented skew matrix. An SDK bump still requires
live two-client netcode testing, because newer SDKs change reconnect behaviour that
the client handles itself. Note the npm SDK is the only leg under the 7-day
`min-release-age` cooldown (`client/.npmrc`), so a fresh release gates the whole
lockstep hop until the SDK ages.

## Procedure

1. **Read the release notes** for every version you skip. Look for changes to module
   syntax, the `describe --json` shape, enum or type encoding, automatic migration
   rules, and log levels.
2. **Switch the local CLI** (`spacetime version install <ver>`,
   `spacetime version use <ver>`), then bump the crate in `Cargo.toml` and run
   `cargo check --workspace --all-targets`. Fix any syntax changes in
   `server-module/src/` (and `.claude/skills/spacetimedb-reducer` if the idioms change).
3. **Regenerate bindings** with `just gen` and commit them in the same change. The
   `bindings-drift` eval compares the committed bindings with a fresh
   `spacetime generate` from the CLI on PATH, so the CLI, CI pins and bindings must
   agree.
4. **Move the CI pins** in both workflows to the same version, in the same commit.
5. **Run `just ci`.** The schema and type snapshot evals
   (`battle-schema-snapshot`, `spacetime-type-snapshot`) compare Rust source, not the
   encoded schema, so they will not see encoding changes; step 6 covers that.
6. **Check the migration against real data — on an ISOLATED data dir.** Two measured
   facts (2026-10-15, 2.8.1→2.11.0) make the old `-s local` form of this step unsafe:
   (a) a newer host STAMPS the data dir's `metadata.toml` on FIRST START — even with
   `--in-memory`, even on a start that then fails — and the old host then refuses to
   start at all ("the database on disk is from Version { ... }"); the stamp is
   one-way. (b) `spacetime publish -s local` talks to whatever host is already
   running, so without an explicit host stop/start between the two publishes the
   "new over old" publish can silently exercise the OLD host. Back up
   `~/.local/share/spacetime/data` before the slice (the first `just ci` after the
   CLI flip stamps the SHARED dir too: `account-e2e` starts a host with no
   `--data-dir`). Then:

   ```sh
   git worktree add ../mr-old <commit-before-the-upgrade>   # the old module source
   ISO=~/.local/share/spacetime-upgrade-proof                # isolated data dir
   # keys: a fresh data dir has none; point at the dev keys explicitly
   <old-bin>/spacetimedb-standalone start --data-dir "$ISO" --listen-addr 127.0.0.1:3111 \
     --jwt-pub-key-path ~/.config/spacetime/id_ecdsa.pub --jwt-priv-key-path ~/.config/spacetime/id_ecdsa &
   (cd ../mr-old && spacetime publish -s http://127.0.0.1:3111 --module-path server-module -y mr-upgrade-check)
   spacetime call -s http://127.0.0.1:3111 mr-upgrade-check sync_content   # seed data
   kill <old host pid>                                       # STOP before the new host
   <new-bin>/spacetimedb-standalone start --data-dir "$ISO" ... &          # same dir: proves the data-dir upgrade
   spacetime version use <new-version>
   spacetime publish -s http://127.0.0.1:3111 --module-path server-module -y mr-upgrade-check
   # assert seeded rows survived, then tear down
   git worktree remove ../mr-old
   ```

   If the host prints `... requires a manual migration` and "Aborting because
   publishing would require manual migration or deletion of data", every existing
   database will need `--delete-data` (which wipes it) or a hand-written migration.
   Then run `MR_SMOKE_DB=mr-upgrade-smoke just smoke-republish`: it publishes, edits
   content, republishes without `--delete-data`, and checks that player data survives
   and the new content version is served.
7. **Check the playtest tooling.** `just playtest-up` against a scratch
   `MR_PLAYTEST_DB` exercises `spacetime describe --json`, which
   `scripts/verify-release-reducers.mjs` parses. It accepts both the older flat
   `{"reducers": [...]}` shape and the `{"sections": [...]}` shape with `source_name`,
   and fails loudly on anything else. A new shape needs a parser update.
8. **Check observability.** Confirm `/v1/metrics` still has the families the recording
   rules use (`ops/observability/rules/`), and that module log lines still reach Loki
   and `mr-trace-relay` (host log levels have changed between releases before).

## Enum variant encoding: check this one specifically

A crate upgrade can change how enum variants are encoded without changing any Rust
identifier. The crate 1.12 → 2.8.1 upgrade renamed every variant from PascalCase to
lowerCamelCase. Source-level snapshots and `bindings-drift` did not notice (the
bindings keep the Rust spelling), but every enum-typed column changed type, and
publishing over an older database aborts:

```
Changing the type of column affinity in table species_row from (Fire: () | Water: () | ...)
to (fire: () | water: () | ...), with a renamed variant, requires a manual migration
Aborting because publishing would require manual migration or deletion of data and
--delete-data was not specified.
```

This still happens with any database created before that upgrade. Such a database
must be republished with `--delete-data` (for the playtest database,
`just playtest-wipe`) or dropped with `spacetime delete` and recreated. On a database
holding real players, that means writing a migration before upgrading.

## Rollback

Roll back the CLI (`spacetime version use <old>`) and revert the upgrade commit
(crate, bindings and CI pins together). Encoding changes apply in both directions: a
database created by the new version may refuse the old module the same way, so plan
`--delete-data` for anything created since the upgrade. Verify with `just ci` and a
republish.

The DATA DIR does not roll back (measured 2026-10-15): once any newer host has
started against `~/.local/share/spacetime/data` — including `account-e2e`'s
`--data-dir`-less `spacetime start --in-memory` inside `just ci` — its
`metadata.toml` is stamped with the newer version and the OLD host refuses to start.
Rolling back past that point means restoring the pre-upgrade backup of the data dir
(take one before every upgrade). Bisecting across the upgrade commit also needs
`spacetime version use <old>` first, or every pre-upgrade commit's `bindings-drift`
eval fails against the new CLI on PATH.

## Standing facts (as of 2.11.0; each re-verified on the 2.8.1→2.11.0 hop)

- Row-level security filters (`#[client_visibility_filter]`) are not enforced.
  Privacy uses private tables with owner-scoped views (see `docs/DECISIONS.md`).
- None of the module's views declares a primary key, so the SDK never fires row updates
  for them. The client rebuilds view-backed collections from the SDK cache after each
  batch (`client/src/net/connection.ts`).
- `spacetime publish` has no visible feature flag in `--help`. The e2e job builds the
  `dev_reducers` wasm with `cargo build ... --features dev_reducers` and publishes it
  with `--bin-path` (`client/e2e/global-setup.ts`).
