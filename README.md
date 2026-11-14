# Monster Realm

A monster-taming game designed to be played alone, with friends on a private server, or on one official
server — the same game in all three. The client runs in a browser. The server is a SpacetimeDB module
written in Rust; the client is TypeScript and PixiJS. Every game rule lives in one
pure Rust crate that both the server and the browser run, so the client can predict
movement instantly while the server stays the only authority.

## The game

*This section is design intent, from the project's game-design document. It describes
what the game is aiming for, not a feature list.*

> A trustworthy, social world where you find, raise, and bond with monsters that are
> genuinely yours — and where knowledge, care, and fair competition matter more than
> reflexes or wallet.

The design rests on four pillars:

1. **Every monster is an individual.** Hidden IVs, trained EVs and a Nature make your
   monster different from anyone else's of the same species, and raising it makes it
   more so.
2. **A fair, authoritative world.** The server is the only truth, so a hard-won
   monster or rating cannot be cheated away.
3. **Knowledge and mastery, not twitch.** Turn-based battles are an affinity puzzle;
   how you raise a monster shapes what it becomes.
4. **A living social fabric.** Trading and PvP make individual monsters matter to
   other players.

It is deliberately not an action game, not idle or farmable, not pay-to-win, and not
online-only: single-player worlds and friends hosting are the planned early-access shape,
and today the repository runs the one-server case they are built from.

**The core loop (intent):** explore a zone, step into grass, meet a wild monster, and
either weaken it to recruit it or defeat it for XP. Between fights, train and care for
your team, then trade or battle other players. The long game is perfecting
individuals, evolving them, and climbing the ranked ladder.

### What exists today

From the code: tile movement across zones with warps; NPCs with dialogue, quests,
shops and heal points; wild encounters and turn-based battles (statuses, abilities,
weather); recruiting; raising (care, training, essence); evolution along an authored
graph; an economy with a wallet, shops and selling; player-to-player trading; PvP
challenges with an Elo leaderboard; a main menu and help overlay; English and French
UI strings; and account deletion and data export. Sign-in and guest-to-account claims
are implemented but inactive until an identity provider is deployed (see
[`ops/auth/README.md`](ops/auth/README.md)). Art is placeholder.

## Prerequisites

| Tool | Version | Where it is pinned |
|---|---|---|
| Rust | 1.99.0, with `wasm32-unknown-unknown`, clippy and rustfmt | `rust-toolchain.toml` (rustup installs it automatically) |
| SpacetimeDB CLI | 2.11.0 | root `Cargo.toml` (`spacetimedb = "2.11.0"`), the npm SDK (`^2.11.0`, lockstep) and `scripts/ci-tools.sh` (CI). Install the CLI with the vendor installer (`curl -sSf -o /tmp/spacetime-install.sh https://install.spacetimedb.com && sh /tmp/spacetime-install.sh --yes`), then `spacetime version install 2.11.0` and `spacetime version use 2.11.0` |
| Node.js | 24.22.0 (`engines` allows `>=24.13.1 <25`) | `client/package.json` `engines`; both workflows use 24.22.0 |
| wasm-pack | 0.15.0 | `scripts/ci-tools.sh` (CI); locally, for example `cargo install wasm-pack --version 0.15.0` |
| just | any recent (CI: 1.58.0) | `scripts/ci-tools.sh` (CI); runs every recipe in `justfile` |
| cargo-nextest | any recent | `just test` uses it |
| Docker | any recent | `just observability-validate`, which `just ci` runs (a missing Docker fails it), and the monitoring stack |
| GNU `timeout` | coreutils | `just playtest-preflight` (every `playtest-*` recipe that publishes); macOS: `brew install coreutils` |

`cargo-mutants` is needed only for the mutation recipes. Of these, playing locally
needs Rust, the SpacetimeDB CLI, Node, wasm-pack, `just` and `timeout`.

## Quickstart: play it locally

```sh
just setup                                    # cargo fetch + client npm install
spacetime start --listen-addr 127.0.0.1:3000  # in another terminal; leave it running
just playtest-up                              # publish, seed, verify, build, serve
```

`just playtest-up` publishes the release module to the database
`monster-realm-playtest`, seeds content, checks that the published module has no dev
reducers and that the client bundle has no debug hooks, builds the production client
(its `shell-config.js` names the playtest database), and serves it with `vite preview` (it
prints the URL, by default
`http://localhost:4173`). Stop the preview with `just playtest-down`; the database
keeps its data. The tester guide is [`docs/PLAYTEST.md`](docs/PLAYTEST.md), and the
operator runbook is [`docs/runbooks/playtest-ops.md`](docs/runbooks/playtest-ops.md).

Binding SpacetimeDB to `127.0.0.1` matters: its default is all interfaces, and its
metrics endpoint is unauthenticated.

## Development loop

There are two separate local setups; do not mix them up:

| | Dev loop | Playtest |
|---|---|---|
| Database | `monster-realm` | `monster-realm-playtest` (`MR_PLAYTEST_DB`) |
| Module | whatever you publish (a `dev_reducers` build belongs here, never in a playtest) | default release build, verified to have no dev reducers |
| Client | `npm run dev`, http://localhost:5290 | production build via `vite preview`, http://localhost:4173 |
| Commands | below | `just playtest-up` / `playtest-down` / `playtest-wipe` |

```sh
spacetime start --listen-addr 127.0.0.1:3000   # local server
spacetime publish -s local --module-path server-module -y monster-realm
cd client && npm run dev                        # Vite dev server on http://localhost:5290
```

The dev server serves `/shell-config.js`, which names `ws://127.0.0.1:3000` and database
`monster-realm` unless `VITE_STDB_URI`/`VITE_STDB_DB` say otherwise; the client reads it
when the page loads. **`just publish` passes no `-s`**, so it
publishes to the spacetime CLI's *default* server, whatever that is. Check it with
`spacetime server list` (the default is starred; a stale default made `just publish`
fail on a connection error while a local server was running) and set it with
`spacetime server set-default local`, or use the explicit command above.
`VITE_STDB_DB` changes the database name `just publish` targets. A first publish runs
`init`, which seeds content and records the publishing identity as the module owner.
After a later content change, call `spacetime call -s local monster-realm sync_content`
as that same identity; other callers are refused.

| Command | What it does |
|---|---|
| `just ci` | The merge gate: lint, typecheck, Rust + node tests, evals, secret scan, wasm build, client typecheck + tests, production-build hook check, observability config validation |
| `just ci-fast <crate>` | clippy + tests for one crate |
| `just test` / `just lint` / `just eval` | The individual stages |
| `just client-test` | vitest |
| `just gen` | Regenerate `client/src/module_bindings` after a schema or reducer change (never edit them by hand) |
| `just e2e` | Playwright two-window e2e against a running SpacetimeDB (needs the `dev_reducers` build; see `client/e2e/global-setup.ts`) |
| `just e2e-shards` | The same suite as `MR_E2E_SHARDS` concurrent Playwright shards (default 8) against the one running SpacetimeDB, each shard with its own database and vite port; builds the `dev_reducers` module itself. See below |
| `just mutate-core` / `just mutate-server` / `just coverage` / `just perf-budget` / `just smoke-republish` | The nightly checks |

### Where the client connects

The client takes its SpacetimeDB target from the page, not from the build. `index.html` loads
a classic script, `/shell-config.js`, before the client module. It sets
`globalThis.__MR_SHELL_CONFIG__` to the shell document, `{ connection: { uri, db, kind } }`
(`kind` is optional). A `shell-config.js` for a friends server is one line:

```js
globalThis.__MR_SHELL_CONFIG__={"connection":{"uri":"wss://play.example/","db":"my-realm","kind":"private"}};
```

`kind` says what the host's server is: `official` (ours, public), `test` (a server we run for
development, CI or playtests), `local` (a single-player world the game started) or `private`
(a friends server). A document without a `kind` is `test` in a development build and `private`
in a production build.

A production build made with `VITE_STDB_DB` set writes `shell-config.js` into `dist/`. One made
without it ships none: its host must serve the file beside `index.html` (or set the global
itself before the client module runs), or the client throws at start-up. Replacing the file
points a built client at another server without a rebuild. Serve it
so a changed copy is picked up (for example `Cache-Control: no-cache`); a stale cached copy
keeps clients on the target it names.

The reconnect token and the guest-claim code are stored under keys derived from the exact `uri`
and `db` strings. A host that changes the spelling of its target (letter case, a trailing slash,
a port) gives every returning anonymous player a new identity. The resolution rules and the
Vite plugin are in `ARCHITECTURE.md`, "Connection and store".

### Running the e2e suite locally

Both recipes need a running SpacetimeDB; `STDB_SERVER` (default: the CLI nickname `local`) and
`VITE_STDB_URI` say where. `just e2e` runs the suite serially in one database and publishes
the module without `dev_reducers` unless `MR_DEV_MODULE_WASM` points at a build that has the
feature. `just e2e-shards` is the fast full run: it builds that module once, then starts
`MR_E2E_SHARDS` Playwright processes, shard `i` in database `<VITE_STDB_DB>-shard-<i>` on vite
port `MR_E2E_PORT + i`. It prints one line per shard with its log path and exits non-zero if
any shard failed.

`MR_E2E_SHARDS` is a plain environment variable (no recipe loads a `.env` file). Its default,
8, is the fastest measured count whose peak memory stays under half of a 45 GB machine's RAM
(22 GB). Measured on 32 logical CPUs; memory is the peak of summed PSS over SpacetimeDB and
every descendant of the recipe (Playwright runners, vite servers, every chromium process):

| `MR_E2E_SHARDS` | wall | peak memory |
|---|---|---|
| serial `just e2e` | 535 s | |
| 2 | 389 s | 3.2 GB |
| 4 | 332 s | 4.6 GB |
| 6 | 265 s | 6.3 GB |
| 8 | 246 s, 228 s (two runs) | 8.0 GB |

Each further shard costs about 0.8 GB. At 8 the shard that holds the suite's one 133 s test
takes 3.6 to 3.9 minutes of the wall on its own. Lower the value on a smaller machine or while
Rust builds and other suites share the box.

Stopping the recipe (Ctrl-C or SIGTERM) stops every shard's runner, vite server and browsers.
With `CI` set, each shard also writes its JSON report to `client/test-results/shards/shard-<i>.json`.

## Repository map

| Path | Contents |
|---|---|
| `game-core/` | Pure, deterministic game rules and the RON content under `game-core/content/` |
| `client-wasm/` | wasm-bindgen exports of `game-core` for the browser |
| `server-module/` | The SpacetimeDB module: tables, views, reducers |
| `client/` | The browser client (TypeScript + PixiJS) and its Playwright e2e specs |
| `sim-harness/` | Headless, seeded netcode driver and a live load driver |
| `evals/` | Repository checks run by `just eval` |
| `scripts/` | Commit, secret, playtest and republish tooling |
| `ops/` | Monitoring stack and identity-provider deployment recipes |
| `docs/` | Decisions, the playtest guide, runbooks |

Start with [`ARCHITECTURE.md`](ARCHITECTURE.md) for how the system fits together and
[`docs/DECISIONS.md`](docs/DECISIONS.md) for why it is built that way. Contribution
rules are in [`CONTRIBUTING.md`](CONTRIBUTING.md); agents also read
[`AGENTS.md`](AGENTS.md).

## License

MIT — see [`LICENSE`](LICENSE).
