# SpacetimeDB 2.16.1: what changed for this game

The game runs on SpacetimeDB 2.16.1: the CLI and host, the Rust crate and the npm SDK
(`docs/DECISIONS.md`, "SpacetimeDB versions move in lockstep"). This document records what changed
between 2.11.0 and 2.16.1 that the game uses or could use, what the crate's `unstable` feature
gates and adds to the built module, and which recorded facts were measured again on 2.16.1. Each
statement names its source: the vendor's release notes (`gh release view v<version> -R
clockworklabs/SpacetimeDB`), the crate sources under `vendor/` (2.16.1), the vendor's "Common
misconceptions" page at tag `v2.16.1` (`docs/docs/00100-intro/00100-getting-started/00550-misconceptions.md`),
or a measurement. Measurements were made on 2026-11-23 on this machine (section 7 of
`docs/local-play.md`), each on a host with its own scratch data directory.

None of the APIs below is used by the module at merge.

## The hops

| Hop             | Why it is a hop                                                                                                                | What it measured                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2.11.0 → 2.12.0 | the commit log (rollback-safe system-table additions); the native test host (`vendor/`, lpw-39)                                 | the native test host's choice and costs ("The vendor's unit-test harness" below)                                                                                                                     |
| 2.12.0 → 2.14.1 | the generated TypeScript bindings (2.14.0 adds `spacetime generate --import-extension`)                                         | the bindings change only in their two version stamps (the option is off here); 1336 of 1336 module tests; `just ci` green                                                                               |
| 2.14.1 → 2.16.1 | old clients skip added columns; TypeScript SDK callback errors fail the connection; republishing a used name is more restricted | the generator no longer writes the deprecated snake_case `DbView` alias types (the bindings still add the aliases at run time); 1336 of 1336; `just ci` green; every fact below                        |

2.13.0 and 2.15.0 mark nothing for this game: 2.13.0's confirmed HTTP calls are below, and 2.15.0's
breaking change is to C# module builds. 2.16.0 has no GitHub release. At each hop both vendored crates
were copied again from crates.io (the `.crate` sha256 equal to the index checksum) and
`vendor/native-host.patch` applied with offsets only (`docs/runbooks/spacetimedb-upgrade.md`); OSV
and GitHub list no advisory for either crate at 2.14.1 or 2.16.1.

## What the `unstable` feature gates

The workspace enables the feature (`docs/DECISIONS.md`, "The crate's `unstable` feature is on; the
generated definition is checked instead"). At 2.16.1 it gates:

| API                                                                                                                                     | Source (2.16.1)                                                                 | One use here                                                                                                                                          | What it would replace, and its cost                                                                                                                                                                                                                                                                                                       | Better for a player?                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| HTTP handlers and routes: `#[spacetimedb::http::handler]`, `#[spacetimedb::http::router]`, `HandlerContext`, the `__call_http_handler__` export | `vendor/spacetimedb/src/http.rs:78-253`, `vendor/spacetimedb/src/rt.rs:1001-1009, 1453-1455` | the host gate's door endpoint (`docs/local-play.md` §3, fork (a)): a joiner posts the world's password to a route the module serves                    | the gate process. The host serves a handler without the connect reducer and without authentication, so the handler would have to make the admission check itself, and the access design rules a handler out for that reason (`docs/DECISIONS.md`, the access entry). Whether a request body reaches the commit log is not measured. | a friends server without a separate gate process; not with the access design as it is                          |
| Row filters: `#[spacetimedb::client_visibility_filter]`, `spacetimedb::Filter`                                                          | `vendor/spacetimedb/src/lib.rs:9-10, 26-27, 107-109`                            | keep an unadmitted connection off the public tables without the connect refusal                                                                       | the connect refusal and the per-reducer check. Enforced at 2.16.1 (below), but a filter that joins another table fails subscriptions or needs a public admission table (measured on 2.11.0, `docs/local-play.md` §3 fork (a)), and it puts the sender in every subscription query                                                     | no: the refusal at connect already gives the same result                                                     |
| `volatile_nonatomic_schedule_immediate!`                                                                                                | `vendor/spacetimedb/src/lib.rs:2582-2584`, `vendor/spacetimedb-bindings-sys/src/lib.rs:429-430, 1753-1755` | the idle tick's follow-up commits: run the next step right after the tick instead of on the next schedule row                                         | a schedule row with no delay. The host queues the call when it runs, so it runs even if the caller then fails, and it runs as the database identity, so it passes every scheduler-only guard (`crates/core/src/host/scheduler.rs:262-267, 953-971` at `v2.16.1`). It is a call, not a declaration: the definition check cannot see it, and only review keeps it out of a reducer a client can call | no                                                                                                            |
| `insert_or_update`, `try_insert_or_update` on a unique column                                                                                | `vendor/spacetimedb/src/table.rs:826-848`                                       | the delete then insert of the `player_session` row on connect (`open_player_session`, `server-module/src/lib.rs`)                                     | nothing: that code must not fail before the connect reducer's early return, `insert_or_update` panics on a constraint violation, and `try_insert_or_update` is the same delete then insert. The comment there names the feature's gate as the reason it is two calls                                                                       | no                                                                                                            |

The check of the generated definition (`findDefinitionViolations`, `just module-definition`,
`just release-module`) refuses a handler, a route or a row filter, so a slice that adopts one
changes that check first. The immediate-schedule call and `insert_or_update` are calls the check cannot
see.

### What the feature adds to the built module

Default build, `cargo build --release --target wasm32-unknown-unknown -p monster-realm-module`, 2.16.1:

|                                         | `unstable` off | `unstable` on                     |
| --------------------------------------- | -------------- | --------------------------------- |
| Size (bytes)                            | 3,480,052      | 3,556,388 (+76,336)               |
| Exports                                 | 165            | 166: adds `__call_http_handler__` |
| Imports                                 | 18             | the same 18                       |
| Definition sections (`extract-schema`)  | 9              | the same 9, the same entries      |

The definition has no `HttpHandlers`, `HttpRoutes` or `RowLevelSecurity` section either way (at
2.11.0 the feature added two sections whether or not a handler existed). Entries are compared by
name: their order differs between two `extract-schema` runs of one file. A host older than 2.14.0
rejects the export's 2.14 signature, which gained the sender and the JWT (release notes, 2.14.0). The native test binary links with the feature on, and
all of the module's tests pass.

## What is stable at 2.16.1

None of these is behind `unstable`, and none is used here.

| API                                                                                  | Source                                                                                                                         | One use here                                                                                                                | What it would replace, and its cost                                                                                                                                                                                                       | Better for a player?                                                                        |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Procedures: `#[spacetimedb::procedure]`, `ProcedureContext::with_tx`, `sleep_until`, `ctx.http` | `vendor/spacetimedb/src/lib.rs:808, 1494, 1639, 1691` (no feature gate); `__call_procedure__` is exported with `unstable` off | a world's own account checks (lpw-35): fetch the account service's keys or a revocation list over HTTP from the module           | the host's own key-set cache (refreshed after 300 s and dropped after 7,200 s at 2.11.0, `docs/runbooks/account-service.md`). A procedure runs outside a transaction and is not deterministic; the reducer census refuses a `procedure` attribute until a slice lists one | yes: a revoked account would reach a world sooner                                            |
| Event tables (`#[spacetimedb::table(..., event)]`)                                   | misconceptions page; `spacetimedb-bindings-macro` 2.16.1 `src/table.rs:164`                                                   | `battle_event` rows sent to the two battlers on commit                                                                       | inserting rows and reaping them later. Event rows are not kept, so a battler who reconnects misses the events sent while it was away; the battle view would need another source for them                                                     | less disk growth per hour of battles (`docs/local-play.md` §6); not measured                 |
| Views with arguments (`SELECT * FROM view(arg)`)                                     | misconceptions page; the `view` macro carries no gate (`vendor/spacetimedb/src/lib.rs:948`)                                    | `characters_in_zone(zone_id)`: the zone's characters, subscribed by argument (an owner view still takes no identity argument) | the zone subscription's SQL text. Each distinct argument is a view instance the host keeps, where one SQL text per zone is shared today ("World rows are subscribed by zone"); not measured | no                                                                                          |
| Tiered storage: `cache_policy` on a table (2.16.1)                                   | release notes, 2.16.1                                                                                                          | stored battle transcripts (`battle_summary`) and `playtest_event` as `no_requirement`, so cold rows leave memory             | the default, everything in memory (`required_in_memory`). A transaction that touches a cold row loads it first, and the load can fail and abort the transaction                                                                              | a friends server's memory (`docs/local-play.md` §6); not measured                           |
| Outbox tables and calls between databases (2.14.0, 2.15.0)                           | release notes                                                                                                                  | a world reporting a binding to the official server                                                                         | the client relaying the call. Both databases must be on hosts that reach each other                                                                                                                                                       | no                                                                                          |
| The unit-test harness (`test-utils`, a feature of its own)                           | `vendor/spacetimedb/Cargo.toml` (`test-utils`), `src/test_utils.rs`                                                            | the hand-written host in `server-module/src/native_host_tests.rs`                                                           | below                                                                                                                                                                                                                                     | no                                                                                          |

Other release-note items that reach the game:

- **Confirmed HTTP calls wait for durability (2.13.0).** A `spacetime call` returns after its
  transaction is durable, with a five-second deadline (HTTP 504 past it). Every recipe that
  publishes over kept data calls `sync_content` this way; `smoke-republish` passed on 2.16.1.
- **`is_internal()` means `sender == database_identity` (2.14.0).** The module never calls it.
- **Republishing a used database name is more restricted (2.16.1, vendor #6547).** The recipes
  republish only names the same identity created. `smoke-republish`, and a publish over a
  database a 2.12.0 host made, passed on 2.16.1.
- **TypeScript SDK callback errors fail the connection (2.16.1).** An error thrown from an
  application callback closes the connection instead of escaping the SDK call. The e2e suite
  passes on 2.16.1.
- **Old TypeScript clients skip trailing added columns (2.16.1, vendor #6091).** Measured below;
  it changes the premise of lpw-25 (`docs/DECISIONS.md`, the protocol-number entry).

The misconceptions page contradicts one statement the game's documents and skills made: that a row
filter is not enforced. The spacetimedb-reducer skill and the upgrade runbook now state what
2.16.1 does. Its other entries (secrets in reducer arguments are not shown to other clients; event
tables; views with arguments; a unit-test harness) contradict nothing written here: the commit log
keeps a reducer's arguments on the host's disk, which is what the access design rests on.

## Facts measured again on 2.16.1

| Fact                                                                                                     | 2.16.1                                                                                                                                                                                       | Where it is recorded                                        |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Every route that reads a row or calls a reducer runs the connect reducer first                           | holds on the routes probed: an identity never admitted gets 403 on eight reducers and on all 72 tables, a WebSocket that closes with no message and an MCP `sql` error; `/schema` answers, and `/route/…` is 404. Not probed: the MCP `call` tool, and `…/call-from-database/<reducer>` (2.14.0), which by its source also goes through the connect reducer and needs a token the host signed | `docs/local-play.md` §3                                     |
| The commit log keeps a committed call's arguments in the clear                                           | holds: the argument sits in the transaction's inputs record                                                                                                                                  | `docs/local-play.md` §3, fork (a)                           |
| A row filter is enforced                                                                                 | holds for a one-table filter: a stranger read 1 of 20 `species_row` rows over `/sql` and in a subscription                                                                                     | `docs/local-play.md` §3, fork (a); the runbook's standing facts |
| A client whose bindings predate an appended column cannot read the table                                  | no longer holds: with SDK 2.16.1 such a client receives its applied callback and the row's known fields (`module_info` with a trailing `u32`)                                                 | `docs/DECISIONS.md`, the protocol-number entry               |
| A database outlives a host upgrade                                                                       | a database a 2.12.0 host made and a player walked on kept every row when a 2.16.1 host opened it and this module was published over it; the player came back with the same identity on the same tile | `docs/runbooks/spacetimedb-upgrade.md` step 6              |
| The metric families the recording rules read (`ops/observability/rules/`)                                | all six present                                                                                                                                                                              | runbook step 8                                              |
| `spacetime describe --json` and `extract-schema` shapes                                                  | `{"sections": [...]}` with `source_name`, and `{"V10":{"sections":[...]}}`: both parse                                                                                                        | runbook step 7                                              |
| `ORDER BY` in SQL, and `--format json`                                                                    | `Unsupported`; one JSON line                                                                                                                                                                 | `scripts/playtest-report.mjs`, `scripts/smoke-republish.sh` |

Not measured again, so each keeps the version it was measured on: the query sharing and pruning
"World rows are subscribed by zone" rests on, the local-play budgets of `docs/local-play.md` §6,
the host's key-set refresh interval (`docs/runbooks/account-service.md`), and the token rows of the
route table (the same connect refusal, exercised over a WebSocket by `evals/account-e2e.eval.mjs`
on every `just ci`).

## The vendor's unit-test harness

The module's tests run on a host this repository defines (`server-module/src/native_host_tests.rs`),
over the two vendor crates patched where they refuse a native host. The choice was made at the
hop to 2.12.0 against the vendor's harness, the `test-utils` feature (A), and the patched crates (B).
Measured on crate 2.12.0 with every Fixture signature kept:

| Build          | Build (s)    | Run (s) | Run ratio | Target dir (GB) | Cargo.lock packages | Passed | Failed |
| -------------- | ------------ | ------- | --------- | --------------- | ------------------- | ------ | ------ |
| 2.11.0, before | 38.30        | 2.652   | 1.00      | 1.9             | 184                 | 1311   | 0      |
| A              | 86           | 34.930  | 13.17     | 5.5             | 673                 | 1108   | 203    |
| B              | 40.62        | 2.744   | 1.03      | 1.9             | 184                 | 1311   | 0      |
| B, stubs only  | not measured | 4.490   | 1.69      | not measured    | 184                 | 542    | 769    |

A's datastore has no hook on a read or a write, so the counters the privacy and netcode tests rest
on (`writes_to`, `rows_read`) cannot count; the shipped views never reach it; a client connection
with no JWT cannot be built; and a write to a table a test did not open goes through instead of
aborting the test. Its 203 failures were 171 `writes_to`, 18 `call_view`, 6 `rows_read`, 3
`requested_indexes`, 2 `Table::delete(row)` (which calls the host directly, still so at 2.16.1), 1
`open_iters`, 1 moved view id and 1 scratch table. It also brings V8 and wasmtime into the test
build (489 more packages). "B, stubs only" switches off only the bindings crate's native stubs: the
table backend still refuses a native host, so 769 tests fail, which is why the patch also changes
the table backend's attributes. A judge scored A 35 and B 78 of 100 against a rubric fixed before
scoring. Two limits of B: one patched site, delete by range, is reached by no test, because no
production code deletes by range and the Fixture defines no
`datastore_delete_by_index_scan_range_bsatn` (the first reducer that does fails the test link until
the Fixture models it); and the module's native test build links on Linux only.

At 2.16.1 the harness also reaches declared environment values and procedures that open
transactions (release notes, 2.13.0), and `ReducerContext::__test` takes an `Environment` first
(2.14.1). It was not measured again at 2.16.1, so the counters, views and JWT-less connections it
lacked at 2.12.0 are still the reasons B stays. B at 2.16.1: the patch applies with offsets only,
and 1337 of 1337 module tests pass (the 1336 of the hops plus the test that links the `unstable`
API).
