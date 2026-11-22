# The native test host on SpacetimeDB 2.12.0 and later

`server-module/src/native_host_tests.rs` gives the module's tests a host. Its `Fixture` runs the
shipped reducers, views and helpers in an ordinary native test binary against an in-memory row
store. It does so by defining the SpacetimeDB host ABI itself: 18 `#[no_mangle]` functions
(`table_id_from_name`, `datastore_*`, `row_iter_bsatn_*`, `bytes_sink_write`, `bytes_source_*`,
`identity`, `get_jwt`). It also reaches the runtime's own entry points (`__call_reducer__`,
`__call_view__`, `__describe_module__`). On crate 2.11.0 this links, and all 1311 server-module
tests pass. From crate 2.12.0 it does not link. This file records why, the two ways the Fixture
can get a host on 2.12.0 and later, what each costs, which one is chosen, and the slice that
builds it (lpw-39). The decision and what it rules out are in `docs/DECISIONS.md` ("Server-module
tests run on our own host ABI, over the two vendor crates patched where they refuse a native
host").

Every number here was measured on 2026-11-22 at commit `eb3cf06c`, on crate 2.12.0, in throwaway
worktrees and target directories under `/tmp` that are not part of this repository. No probe was
committed. "Run" is the time in nextest's `Summary` line for
`cargo nextest run -p monster-realm-module`. "Cold build" is the wall-clock time of the same
command with `--no-run`, into an empty target directory, with the crates already downloaded. The machine has
32 cores. Line citations into the vendor's sources are to the crates.io packages of the version
named.

## What breaks on 2.12.0

Two changes in the vendor's crates break it, and they are independent:

1. **`spacetimedb-bindings-sys` defines the host ABI on native targets.** `src/lib.rs:990` opens
   `mod native_link_stubs` under `#[cfg(not(target_arch = "wasm32"))]`. It holds strong
   `#[unsafe(no_mangle)]` definitions of every host function, and each answers
   `NOT_IN_TRANSACTION`. No feature turns the module off. The test binary therefore fails to
   link, with 18 duplicate symbols: the same names `native_host_tests.rs` defines.
2. **`spacetimedb` stops calling the ABI on native targets.** Each host-backed table operation in
   `src/table.rs` (`TableHandleBackend`, lines 61 to 303: table id, insert, table scan, row count,
   point scan, range scan, delete by point, delete by range, update) has a
   `#[cfg(not(target_arch = "wasm32"))]` branch that returns `Errno::HOST_CALL_FAILURE` without
   calling `sys`. `TableIterInner::Host` has the same split (lines 1867 to 1950).
   `ReducerContext::database_identity()` panics on native unless `test-utils` is on
   (`src/lib.rs:1244`). The generated table code never reaches a host function natively at all.

The first change alone breaks the link. With it undone and the second left in place, the binary
links and 769 tests fail (B1 below). That is the same count lpw-34 measured when it forced the
link with `-Wl,--allow-multiple-definition`. The same three sites are in 2.14.1 and 2.16.1:
`native_link_stubs` behind the same `cfg` at `src/lib.rs:990`, the 12 native-only branches and
23 `HOST_CALL_FAILURE` uses in `table.rs`, and the `database_identity` panic.

## The alternatives

| Alternative | Where the Fixture's host comes from | Fixture API changed | Server-module tests changed | Probe on 2.12.0 |
|---|---|---|---|---|
| A — the vendor's `test-utils` feature | `spacetimedb = { workspace = true, features = ["test-utils"] }` as a dev-dependency. The Fixture owns a `spacetimedb::test_utils::TestContext` per test: a fresh `TestDatastore` (the vendor's real in-memory `RelationalDB`) built from `test_utils::module_def()`. Contexts come from `ReducerContext::__test(ctx.db.clone(), sender, auth, connection, timestamp, module identity, None)`, JWTs from `AuthCtx::from_jwt_payload`. The 18 ABI functions, the `run_as` trampoline and the 91 describer externs are deleted. | 6 members cannot be kept: `writes_to`, `rows_read`, `requested_indexes`, `open_iters`, `call_view`, and `run_as_conn_at` with no JWT. `writable`, `scannable`, `unique` and `auto_inc` keep their signatures and do nothing. | 203 fail, by cause in "What A changes" | links with `--lib` only; 1108 passed, 203 failed |
| B — the vendor crates patched where they refuse a native host | `[patch.crates-io]` points `spacetimedb` and `spacetimedb-bindings-sys` at copies of their crates.io 2.12.0 sources under `vendor/`. In each copy, 27 `#[cfg]` attributes change and nothing else (listed in "The patch"). The Fixture keeps its own ABI host, which the generated code now reaches again. | none | none | links; 1311 passed, 0 failed |

### What A changes

The Fixture's signatures can all be kept, so the tests still compile. But the vendor's datastore
answers none of these questions:

- **Counting.** `TestDatastore` has no hook on a read or a write, so `writes_to` (160 uses in
  21 test files) and `rows_read` (17 uses in 9 files) cannot count. These are a transaction's
  subscription-visible footprint, which a row diff cannot see: an unchanged `update` still
  reaches subscribers.
- **Diagnostics.** No log of the index names the generated code asked for (`requested_indexes`,
  81 uses). Its scans return a `Vec`, so no row iterator is ever open (`open_iters`).
- **Views.** `__call_view__` builds `ViewContext::new(sender)` over the host backend
  (`src/rt.rs:1476`, `src/lib.rs:1033`), and the shipped view functions are private to
  `schema.rs` and `privacy.rs`. So `call_view` (46 uses in 8 files) cannot run a shipped view
  unless those functions are made visible to the test module. Under `test-utils` the views also
  register in another order, so the positional `VIEW_*` ids move.
- **Anonymous connections.** `AuthCtx`'s constructor for a client connection with no JWT is
  private (`src/lib.rs:2299`). `run_as_conn_at(.., None, ..)` can only hand over an internal
  context, whose `is_internal()` is true.
- **The write wall.** The datastore enforces every constraint in the module definition and lets
  every write through. A write or a full scan on a table the test did not opt in no longer aborts
  the test. That abort is how several suites kill a mutant that writes to a table it should not
  touch (`lifecycle_tests.rs:17`). Those tests keep passing and stop killing those mutants. No
  mutation run was made, so the number of mutants this loses is not measured.
- **Gaps in the vendor's own harness.** `Table::delete(row)` and `Table::clear()` call `sys`
  directly, not the test backend (`src/table.rs:449`, `:458`), so natively they panic with
  `Failed to get table with name`. This is still so at 2.16.1.

The 203 failures of the probe, by cause:

| Cause | Failing tests |
|---|---|
| `writes_to` has no counter | 171 |
| `call_view` cannot run a shipped view | 18 |
| `rows_read` has no counter | 6 |
| `requested_indexes` has no log | 3 |
| `open_iters` sees no iterator | 1 |
| view ids are positional and move | 1 |
| `Table::delete(row)` bypasses the test backend | 2 |
| a scratch table outside the module definition (`nh_scannable_writable_table_scans_counts_deletes_and_clears`) | 1 |

No failure came from a constraint refusing a seed, or from a read the vendor's datastore
answered differently from the hand-written host.

A also costs the build. With `test-utils` on, `spacetimedb` depends on `spacetimedb-core`, the
whole server: the V8 engine (`v8` 145, which downloads a 170 MB prebuilt `librusty_v8.a` from
GitHub on every cold build), `wasmtime` and `cranelift`, `openssl-sys` built from source,
`tokio` and `reqwest`. `Cargo.lock` grows from 184 packages to 673. A fresh resolution does not
compile: it picks `icu_calendar` 2.4.0, which `temporal_rs` 0.1.2 cannot build against, so the
lock has to hold the `icu_*` crates at the vendor's 2.1.x. The feature is unified into the
module's own cdylib when tests are built. V8's thread-local relocation (`R_X86_64_TPOFF32`)
cannot go into a `-shared` object, so the cdylib fails to link: measured with
`cargo nextest run -p monster-realm-module --no-run`, and avoided with `--lib`. So every test
command that builds the module's library would need `--lib` or an equivalent: the four
`cargo nextest` lines of `just test`, `cargo test --doc --workspace` and `cargo mutants`. And
all 489 added crates enter the scope of `cargo audit`, a blocking CI gate.

### What B changes

The Fixture, its API and every test stay as they are. What B adds is around them:

- **Two vendored crates.** 48 files, 11,797 lines of Rust, copied from crates.io unchanged
  except for the 27 attributes. They are not workspace members (measured with
  `cargo metadata`), so `cargo fmt --all`, `cargo clippy --workspace` and `cargo mutants` do not
  reach them (mutants lists 0 mutants under `vendor/`). Biome skips them: their only non-Rust
  files are `.json`, which `biome.json` excludes. The secret scans pass over them:
  `check-secrets` is clean, and gitleaks with `.gitleaks.toml` scanned 707 KB and found nothing.
- **The release artefact.** On wasm every patched attribute selects what it selected before, so
  the release module built over the patched copies is byte-identical to one built over the
  unmodified copies at the same path (sha256
  `2c2d3af5cc546a4721abd556409bfff958443c12c1dbc6103d6bf80e860e871b`, both). So the patch adds
  nothing to what ships. Building the crates from a path rather than from the registry does
  change the bytes: against a crates.io build, the type, import, table, memory and global
  sections are identical, and the function, export, element, code, data and name sections
  differ. The data strings that differ are the crates' source paths, which panic locations embed.
- **SCA coverage.** `cargo audit` 0.22.2 (rustsec 0.33, `Database::query_vulnerabilities`)
  skips every lockfile package whose source is not crates.io. So an advisory against the
  `spacetimedb` or `spacetimedb-bindings-sys` crate itself would no longer fail CI. Their
  dependencies (`spacetimedb-lib`, `-sats`, `-primitives`, `-bindings-macro`,
  `-query-builder`) stay registry crates and are still audited.
- **Every hop.** Each SpacetimeDB upgrade re-copies both crates at the new version and applies
  the same 27 changes. Forgetting is loud: an unpatched copy fails to link, and a half-patched
  one fails 769 tests.
- **The temp workspace of `account-e2e`.** `evals/account-e2e.eval.mjs` copies the workspace
  into a temp directory by a fixed list (`WORKSPACE_MEMBERS` and `WORKSPACE_ROOT_FILES`, lines
  88 to 95, copied at line 2690). Without `vendor/` in that list, the `[patch]` paths do not
  resolve there. This was read from the code. The eval was not run on the probe, because it
  starts a host, and a 2.12.0 host stamps the shared data directory.

### Ruled out

- **B1, the stubs switched off and nothing else.** It links, and 542 passed and 769 failed,
  because of change 2 above.
- **A linker flag that tolerates the duplicates.** `-Wl,--allow-multiple-definition` links, and
  the vendor's stubs win: 769 fail (lpw-34, note n2). lpw-39.2 also forbids any such flag.
- **Tests on crate 2.11.0 while the module ships on a later one.** This breaks "SpacetimeDB
  versions move in lockstep": the crate version is the product version.

## The cost of a test run, measured on crate 2.12.0

| Build | Cold build (s) | Run (s) | Run ratio | Target dir (GB) | Cargo.lock packages | Passed | Failed |
|---|---|---|---|---|---|---|---|
| 2.11.0 today | 38.5 | 2.652 | 1.00 | 1.9 | 184 | 1311 | 0 |
| A | 86.7 | 34.930 | 13.17 | 5.5 | 673 | 1108 | 203 |
| B | 40.8 | 2.744 | 1.03 | 1.9 | 184 | 1311 | 0 |
| B1 | not measured | 4.490 | 1.69 | not measured | 184 | 542 | 769 |

"Run ratio" is the row's run time over the 2.11.0 row's. B1 was built into a target directory
that already held 2.12.0's dependencies, so it has no cold figure. A's run is slower because each
`fixture()` builds a fresh `RelationalDB` holding the module's 72 tables. A was built and run
with `--lib`, which its cdylib needs.

## The judge

A `judge` subagent scored both alternatives against a rubric whose weights and tie-break were fixed
before it scored. It verified the facts it used against the probe logs and the vendor sources, and
re-ran parts of the measurement itself:

| Criterion | Weight | A | B |
|---|---|---|---|
| Keeps the Fixture's API and every server-module test's assertion | 30 | 4 | 30 |
| The host answers what the tests ask, as the real host would | 20 | 11 | 12 |
| Release artefact and supply chain | 20 | 10 | 12 |
| Cost of a test run | 15 | 2 | 14 |
| Work at each SpacetimeDB hop | 15 | 8 | 10 |
| **Total** | 100 | 35 | 78 |

The tie-break would have applied within five points: fewer server-module assertions changed,
then the smaller difference in the shipped artefact. It was not needed. The judge's reasons, in
short:

- **API and assertions.** A keeps the signatures in name only: 203 tests fail, and the walls
  behind 436 `.writable()` and `.scannable()` calls in 28 files stop aborting anything. B keeps
  all 1311.
- **Fidelity.** A gains the vendor's real constraint, sequence and schema checks, which no
  current test needed. But it runs the SDK's test-only backend branch, not the one that ships,
  and it loses `Table::delete(row)`, JWT-less connections and every test-strength feature. B runs
  the shipped `sys` branch and keeps those features. Its model is still partial: unique
  constraints are opt-in, one sequence column per table, no rollback.
- **Supply chain.** A adds 489 packages and a network-fetched V8 binary to the test build. B adds
  no third-party package, and its wasm is the vendor's code. But it takes the two crates out of
  `cargo audit`'s scope, and they are the module's most security-relevant crates.
- **Cost.** A's runs take 12.7 to 13.2 times as long, it needs 2.9 times the disk, and it forces
  `--lib` onto the test commands. B is at parity with 2.11.0.
- **Hops.** A carries no fork, but the hidden constructor it builds on changes at 2.14.1
  (`ReducerContext::__test` gains an `env: Environment` first parameter). B re-applies 27
  mechanical edits; a dry run applied every hunk to 2.14.1 and 2.16.1 at shifted lines, with no
  rejects. Neither version was built with the patch.

## The choice

**B: the two vendor crates, patched where they refuse a native host.** It is the only
alternative that keeps the Fixture's API and every test, which lpw-39's contract requires. Its
test runs cost what they cost on 2.11.0, and the module it ships is the vendor's own code. A
gives up the counters, the wall and the views that most of the module's tests rest on, at 13
times the run time and 489 more crates.

**It lands as lpw-34's first lockstep hop, to 2.12.0, not on 2.11.0.** Neither alternative
exists at 2.11.0: that version defines no stubs to switch off and has no `test-utils` feature.
And lpw-39.2 is a criterion on crate 2.12.0. So lpw-39 moves the CLI, the host, the crate and the
npm SDK to 2.12.0 together, by `docs/runbooks/spacetimedb-upgrade.md`. The SDK 2.12.0 was
published on 2026-10-13, so it is past the 7-day cooldown. It declares no `engines` field, so
Node 24.22.0 serves. The CLI's sha256 for CI is
`154853dd882abe1e6f8b96e169f9ca43a075df006dd33116b85d03c59a912f89`.

## The patch

Both crates are copied from their crates.io 2.12.0 packages into `vendor/spacetimedb` and
`vendor/spacetimedb-bindings-sys`. Then exactly these attributes change, and nothing else. Line
numbers are unchanged by the patch.

| Crate | File | Lines | From | To |
|---|---|---|---|---|
| `spacetimedb-bindings-sys` | `src/lib.rs` | 990 | `#[cfg(not(target_arch = "wasm32"))]` | `#[cfg(any())]` |
| `spacetimedb` | `src/table.rs` | 61, 108, 136, 162, 184, 217, 244, 275, 299, 1867, 1879, 1931 | `#[cfg(target_arch = "wasm32")]` | `#[cfg(all())]` |
| `spacetimedb` | `src/table.rs` | 65, 112, 140, 166, 188, 222, 248, 279, 303, 1869, 1881, 1950 | `#[cfg(not(target_arch = "wasm32"))]` | `#[cfg(any())]` |
| `spacetimedb` | `src/lib.rs` | 1231 | `#[cfg(target_arch = "wasm32")]` | `#[cfg(not(all(feature = "test-utils", not(target_arch = "wasm32"))))]` |
| `spacetimedb` | `src/lib.rs` | 1244 | `#[cfg(all(not(feature = "test-utils"), not(target_arch = "wasm32")))]` | `#[cfg(any())]` |

`#[cfg(all())]` is always on and `#[cfg(any())]` always off. So on every target, each table
operation takes the branch wasm takes, which calls `sys`. `database_identity()` reads the
`identity` host function. And the stubs module is gone. The probe applied the `table.rs` rows
with two `sed` substitutions over the whole file, anchored on lines that hold only the attribute
(`^(\s*)#\[cfg\(target_arch = "wasm32"\)\]$` and its `not(...)` twin), which match exactly these
24 lines. The `lib.rs` rows are line-addressed.

On the probe, with the workspace pin `spacetimedb = "=2.12.0"` and this `[patch.crates-io]`:

```toml
[patch.crates-io]
spacetimedb = { path = "vendor/spacetimedb" }
spacetimedb-bindings-sys = { path = "vendor/spacetimedb-bindings-sys" }
```

| Command (crate 2.12.0, patched) | Passed | Failed |
|---|---|---|
| `cargo nextest run -p monster-realm-module` | 1311 | 0 |
| `cargo nextest run --workspace --features monster-realm-module/dev_reducers -E 'package(monster-realm-module)'` | 1329 | 0 |
| `cargo nextest run --workspace --features monster-realm-module/load_test_zones -E 'package(game-core) \| package(monster-realm-module)'` | 3298 | 0 |
| `cargo nextest run --workspace --no-default-features --features monster-realm-module/dev_issuers -E 'package(monster-realm-module) & test(/acs6_enforcing/)'` | 18 | 0 |
| `cargo nextest run --workspace` | 3626 | 0 |

No test failed on the probe, so there is no failing test to name. `cargo test --doc --workspace`
passed, and so did `cargo clippy --workspace --all-targets --all-features -- -D warnings`. The
14 evals other than `account-e2e` passed too, with the 2.12.0 CLI first on `PATH` and the
regenerated bindings (so `bindings-drift` compared against a 2.12.0 `generate`).

The other legs of the hop were measured too, without starting a 2.12.0 host. `spacetime
generate` from the 2.12.0 CLI changes one generated file, `client/src/module_bindings/index.ts`,
and in it only the two CLI-version stamps. With the npm SDK at 2.12.0, `npm run typecheck`
passes, and `npm test` passes 6491 of 6492 (the one failure is under "Tests whose assertion
changes").

## lpw-39

lpw-39 is the hop itself: the patch above, the version moves the runbook lists, and every
statement that names 2.11.0 as the version in use. A statement that records something measured
on 2.11.0 keeps its version; lpw-34 re-measures those. lpw-39 runs alone. It switches the CLI
only inside its own shell (the 2.12.0 binaries first on `PATH`, `HOME` pointed at a scratch
directory, `RUSTUP_HOME` and `CARGO_HOME` exported), because a 2.12.0 host stamps the data
directory it starts on, and the old host then refuses that directory.

| File | What changes |
|---|---|
| `Cargo.toml` | the pin becomes `spacetimedb = "=2.12.0"`, the `[patch.crates-io]` table above is added, and the pin's comment states both |
| `Cargo.lock` | the seven `spacetimedb*` packages at 2.12.0; the two patched ones become path packages |
| `vendor/spacetimedb/**` | new: the crates.io 2.12.0 package with the patch |
| `vendor/spacetimedb-bindings-sys/**` | new: the crates.io 2.12.0 package with the patch |
| `server-module/Cargo.toml` | the dependency comment names the version and the patched copies |
| `server-module/src/native_host_tests.rs` | comments only: the citations into the 2.11.0 sources point at `vendor/` at 2.12.0, and the module comment says why the host is reachable |
| `evals/account-e2e.eval.mjs` | `vendor` joins the directories copied into its temp workspace |
| `scripts/ci-tools.sh` | `SPACETIME_VERSION=2.12.0` and its sha256 |
| `client/package.json` | `"spacetimedb": "^2.12.0"` |
| `client/package-lock.json` | the SDK at 2.12.0 |
| `client/src/module_bindings/index.ts` | regenerated by `just gen` (the CLI-version stamps) |
| `client/src/net/authToken.test.ts` | the SDK-drift needle (under "Tests whose assertion changes") |
| `client/src/net/authToken.ts` | the comment that quotes the SDK's rejection message and its `dist` lines |
| `docs/runbooks/spacetimedb-upgrade.md` | the current pin; a step that re-copies and re-patches `vendor/` at each hop, with the diff against the pristine package in the PR |
| `docs/DECISIONS.md` | the lockstep entry's version; the test-host entry to the built state |
| `ARCHITECTURE.md` | the server-tests row: the host runs over the patched vendor crates |
| `AGENTS.md` | the toolchain row's version |
| `README.md` | the toolchain table's version and pin |
| `docs/PLAYTEST.md` | the CLI version it asks for |
| `docs/runbooks/playtest-ops.md` | the CLI version it asks for |
| `docs/e2e-flakes.md` | the host version the e2e starts |
| `docs/local-play.md` | §3's quotation of the `Cargo.toml` pin (line 546) |
| `scripts/playtest-report.mjs` | comments that call 2.11.0 the pinned CLI |
| `.claude/skills/spacetimedb-reducer/SKILL.md` | the versions it states and the docs.rs link |
| `.claude/skills/spacetimedb-client/SKILL.md` | the versions it states |
| `docs/refactors/native-test-host.md` | deleted: lpw-39 is the last slice of this plan |

After it, lpw-34 starts from 2.12.0, and each later hop re-applies the patch.

## Tests whose assertion changes

No server-module test changes: B keeps every one, and the probe passed all 1311 unchanged.

One test outside the module changes, in the SDK leg of the hop:

| Test | Reason |
|---|---|
| `client/src/net/authToken.test.ts` :: `SDK-DRIFT (nh4): the spacetimedb SDK still throws the exact token-rejection message string > BITES: dist/index.mjs contains the literal substring "Failed to verify token: ${response.statusText}"` | SDK 2.12.0 adds the HTTP status to the message: its `dist/index.mjs` throws `Failed to verify token: ${status} ${statusText}`. So the needle becomes that string. `isStoredCredentialRejected` matches on the prefix `Failed to verify token: `, which is unchanged, and every other test in the file passes on 2.12.0. |

`moved-tests:` none.
