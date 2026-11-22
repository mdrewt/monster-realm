# The native test host on SpacetimeDB 2.12.0 and later

`server-module/src/native_host_tests.rs` gives the module's tests a host. Its `Fixture` runs the
shipped reducers, views and helpers in an ordinary native test binary against an in-memory row
store. It defines the SpacetimeDB host ABI itself as 18 `#[no_mangle]` functions
(`table_id_from_name`, `index_id_from_name`, the `datastore_*` scans and writes,
`row_iter_bsatn_*`, `bytes_sink_write`, `bytes_source_*`, `identity`, `get_jwt`). It also reaches
the runtime's own entry points (`__call_reducer__`, `__call_view__`, `__describe_module__`). On
crate 2.11.0 this linked, and all 1311 server-module tests passed. Against the unmodified crates
of 2.12.0 and later it does not link. The module is on crate 2.12.0 and builds two of the vendor's
crates from patched copies under `vendor/`, so the test binary links and every test passes. This
file covers:

- why the unmodified crates break it;
- the two ways the Fixture can get a host on 2.12.0 and later, and what each costs;
- which one is chosen;
- how it is built: the copies, the patch, the guard test and the hop ("The hop to 2.12.0, as
  built").

The decision and what it rules out are in `docs/DECISIONS.md` ("Server-module tests run on our
own host ABI, over the two vendor crates patched where they refuse a native host").

All of this was measured on 2026-11-22, on a 32-core machine, at commit `eb3cf06c`, in
throwaway worktrees and target directories under `/tmp`. No probe was committed.

- **The 2.11.0 row** was built from the lpw-38 worktree itself.
- **B's cost row** used vendored copies outside the workspace.
- **Everything else measured for B** used copies at `vendor/` inside the workspace, the layout
  the repository now holds. That covers the feature-set runs, `unstable`, fmt, clippy, mutants, the evals
  and the wasm hashes.

Units:

- "Run" is the time in nextest's `Summary` line for `cargo nextest run -p monster-realm-module`.
- "Build" is cargo's `Finished` time for the same command with `--no-run`, into an empty target
  directory, with the crates already downloaded.

Line citations into the vendor's code are to the crates.io packages of the version named.

## What breaks on 2.12.0

Two changes in the vendor's crates break it, and they are independent:

1. **`spacetimedb-bindings-sys` defines the host ABI on native targets.** `src/lib.rs:990` puts
   `mod native_link_stubs` under `#[cfg(not(target_arch = "wasm32"))]`. It holds strong
   `#[unsafe(no_mangle)]` definitions of every host function. Each one refuses: an error code
   (`NOT_IN_TRANSACTION`, `NO_SUCH_ITER` or `NO_SUCH_BYTES`), a no-op, or an all-zero identity.
   No feature turns the module off. So the test binary fails to link, on 18 duplicate symbols:
   the names `native_host_tests.rs` defines.
2. **`spacetimedb` stops calling the ABI from its table backend on native targets.**
   - In `src/table.rs`, each host-backed table operation of `TableHandleBackend` (lines 61 to 303:
     table id, insert, table scan, row count, point scan, range scan, delete by point, delete by
     range, update) has a `#[cfg(not(target_arch = "wasm32"))]` branch. That branch returns
     `Errno::HOST_CALL_FAILURE` without calling `sys`.
   - `TableIterInner::Host` has the same split (lines 1867 to 1950).
   - `ReducerContext::database_identity()` panics on native unless `test-utils` is on
     (`src/lib.rs:1244`).
   - Some generated code still calls `sys` directly on every target: the memoised `table_id()` and
     `index_id()` lookups, `Table::delete(row)` and `Table::clear()` (`src/table.rs:449`, `:458`).
     But the scans, inserts, updates and deletes by index that most tests reach go through the
     backend, and refuse.

The first change alone breaks the link. Undo it but not the second, and the binary links and 769
tests fail (B1 below). That is the same count lpw-34 measured when it forced the link with
`-Wl,--allow-multiple-definition`. The same sites are in 2.14.1 and 2.16.1:

- `native_link_stubs` behind the same `cfg` at `src/lib.rs:990`;
- the 12 native-only pairs and 23 `HOST_CALL_FAILURE` uses in `table.rs`;
- the `database_identity` panic.

## The alternatives

| Alternative | Where the Fixture's host comes from | Fixture API changed | Server-module tests changed | Probe on 2.12.0 |
|---|---|---|---|---|
| A — the vendor's `test-utils` feature | `spacetimedb = { workspace = true, features = ["test-utils"] }` as a dev-dependency. The Fixture owns a `spacetimedb::test_utils::TestContext` per test: a fresh `TestDatastore`, the vendor's real in-memory `RelationalDB`, built from `test_utils::module_def()`. Contexts come from `ReducerContext::__test(ctx.db.clone(), sender, auth, connection, timestamp, module identity, None)`, and JWTs from `AuthCtx::from_jwt_payload`. The 18 ABI functions, the `run_as` trampoline and the 91 describer externs are deleted. | 6 members keep their signature and lose their behaviour: `writes_to`, `rows_read`, `requested_indexes`, `open_iters`, `call_view`, and `run_as_conn_at` with no JWT. `writable`, `scannable`, `unique`, `auto_inc`, `reset_writes` and `reset_reads` do nothing. | 203 fail, by cause in "What A changes" | links with `--lib` only; 1108 passed, 203 failed |
| B — the vendor crates patched where they refuse a native host | `[patch.crates-io]` points `spacetimedb` and `spacetimedb-bindings-sys` at copies of their crates.io 2.12.0 packages under `vendor/`. 27 `#[cfg]` attributes change across the two copies, 1 in `spacetimedb-bindings-sys` and 26 in `spacetimedb`, each with a change notice at the end of its line. Nothing else changes ("The patch"). The Fixture keeps its own ABI host, which the table backend calls again. | none | none | links; 1311 passed, 0 failed |

### What A changes

Every Fixture signature can be kept, so the tests still compile. But the vendor's datastore
answers none of these:

- **Counting.** `TestDatastore` has no hook on a read or a write. So `writes_to` (155 calls in 21
  test files) and `rows_read` (17 calls in 9 files) cannot count. They measure a transaction's
  subscription-visible footprint, which a row diff cannot see: an unchanged `update` still
  reaches subscribers.
- **Diagnostics.** There is no log of the index names the generated code asked for
  (`requested_indexes`, 80 calls). Scans return a `Vec`, so no row iterator is ever open
  (`open_iters`).
- **Views.** `__call_view__` builds `ViewContext::new(sender)` over the host backend
  (`src/rt.rs:1476`, `src/lib.rs:1033`), so it never reaches the test datastore. The shipped view
  functions are private to `schema.rs` and `privacy.rs`. A port could run them through
  `ViewContext::__test` only after making them visible to the test module, which the probe did
  not do; `call_view` has 43 calls in 8 files. Under `test-utils` the views also register in
  another order, so the positional `VIEW_*` ids move.
- **Anonymous connections.** `AuthCtx`'s constructor for a client connection with no JWT is
  private (`src/lib.rs:2299`). So `run_as_conn_at(.., None, ..)` can only hand over an internal
  context, whose `is_internal()` is true.
- **The write wall.** The datastore enforces every constraint in the module definition and lets
  every write through. A write or a full scan on a table the test did not opt in goes through
  instead of aborting the test. Several suites use that abort to kill a mutant that writes to a table it should not
  touch (`native_host_tests.rs:795-797`; for example the two `rb73_exec_*` tests,
  `lifecycle_tests.rs:16-19`). Those tests keep passing and stop killing those mutants. The
  `.writable()` and `.scannable()` opt-ins are 432 calls in 28 files. No mutation run was made,
  so the number of mutants lost is not measured.
- **Gaps in the vendor's own harness.** `Table::delete(row)` and `Table::clear()` call `sys`
  directly, not the test backend (`src/table.rs:449`, `:458`). So natively they panic with
  `Failed to get table with name`. This is still so at 2.16.1.
- **The next hop.** At 2.14.1, `ReducerContext::__test` gains an `env: Environment` first
  parameter. So A's Fixture changes again at that hop.

The 203 failures of the probe, classified by each test's first panic:

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

The probe port keeps the signatures and implements nothing more. A fuller port could recover the
18 `call_view` failures by making the view functions visible. No failure came from a constraint refusing a
seed, or from a read the vendor's datastore answered differently from the hand-written host.

A also costs the build:

- **The dependency tree.** With `test-utils` on, `spacetimedb` depends on `spacetimedb-core`, the
  whole server: the V8 engine (`v8` 145), `wasmtime` and `cranelift`, `openssl-sys` built from
  source, `tokio` and `reqwest`. `Cargo.lock` grows from 184 packages to 673.
- **A network-fetched binary.** On a machine with no copy in `$CARGO_HOME/.rusty_v8`, a cold build
  downloads a prebuilt `librusty_v8` archive from GitHub (170 MB unpacked). The probe machine had none, so A's
  build time includes that download.
- **A pinned lockfile.** A fresh resolution does not compile: it picks `icu_calendar` 2.4.0, which
  `temporal_rs` 0.1.2 cannot build against. So the lock has to hold the `icu_*` crates at the
  vendor's 2.1.x.
- **`--lib` everywhere.** The feature is unified into the module's own cdylib when tests are
  built. V8's thread-local relocation (`R_X86_64_TPOFF32`) cannot go into a `-shared` object, so
  the cdylib fails to link. This was measured with `cargo nextest run -p monster-realm-module
  --no-run` and avoided with `--lib`. So every test command that builds the module's library
  would need `--lib` or an equivalent: the four `cargo nextest` lines of `just test`,
  `just ci-fast`, `cargo test --doc --workspace` and `cargo mutants`.
- **Audit scope.** All 489 added crates enter the scope of `cargo audit`, a blocking CI gate.

### What B changes

The Fixture, its API and every test stay as they are. What B adds is around them:

- **Two vendored crates.** 44 files and 11,797 lines of Rust, from the crates.io packages. Each
  copy omits its `Cargo.lock`, which cargo ignores outside the workspace root (`spacetimedb`'s
  lists 596 packages, `v8` and `wasmtime` among them). The copies are unpacked from the `.crate`
  files, which hold no `.cargo-ok`: that marker is written by cargo when it unpacks a package
  into its registry cache, where the probe's copies came from.
- **Tooling never reaches them.** They are not workspace members: `cargo metadata` lists the 5
  members. So `cargo fmt --all --check`, `cargo clippy --workspace` and `cargo mutants` never
  reach them (all run: no diff, no warning, 0 mutants under `vendor/`). Biome has nothing to read
  there: their only file type it handles is `.json`, which `biome.json` excludes. The secret scans
  pass over them: `check-secrets` is clean, and gitleaks with `.gitleaks.toml` scanned 707 KB and
  found nothing.
- **The shipped module.** On wasm, every patched attribute selects what it selected before. So a
  release build over the patched copies is byte-identical to one over the unmodified copies at the
  same path. Measured for four builds:

  | Release build | sha256 |
  |---|---|
  | default features | `9531db117bcc9d7ec7ea9e5f1009c4663c99795ac25c9da5b2b89c144a345cce` |
  | `--no-default-features --features official` | `581f856542fc5e2f14f36e2fa61dc23f598cf7d557f6292277d288714d8688e3` |
  | `--no-default-features --features world` | `7fcdeac2fbd3061913b719369ea8b4bab520b72b77fcbff84a005d7b47648e98` |
  | `--features dev_reducers` | `f76d0c54719239ce9e54d235e738cf104237db89bfc40ee96846429907e2581e` |

  Building the crates from a path rather than from the registry does change the bytes. Against a
  crates.io build, the type, import, table, memory and global sections are identical, and the
  function, export, element, code, data and name sections differ. The data strings that differ
  are the crates' source paths, which panic locations embed.
- **Provenance takes a test, not a checksum.** Today `Cargo.lock` holds a checksum for each
  registry package, which `cargo` verifies. A path package has none. And a wasm-only edit inside a
  copy passes every native test: one planted in `JwtClaims::issuer()`, which `accounts.rs`
  trusts, leaves all 1311 passing. So a test proves that each copy, with the patch undone,
  matches the per-file hashes recorded from the crates.io release ("The guard").
- **SCA coverage.** `cargo audit` skips every lockfile package whose source is not crates.io
  (rustsec 0.33, `Database::query_vulnerabilities`; `cargo-audit` 0.22.2, the version CI
  installs, declares `rustsec = "^0.33"`). So CI's audit does not cover `spacetimedb` or
  `spacetimedb-bindings-sys` themselves once they are path packages. Their dependencies (`spacetimedb-lib`, `-sats`,
  `-primitives`, `-bindings-macro`, `-query-builder`) stay registry packages and are still
  audited. No advisory has been filed against any of these crates: on 2026-11-22 OSV returned
  none, and GitHub had none for the ecosystem or for the vendor's repository. The vendor announces
  fixes in release notes, which the upgrade runbook already reads at each hop.
- **Every hop.** Each SpacetimeDB upgrade re-copies both crates at the new version and applies
  `vendor/native-host.patch`, a unified diff with three lines of context per hunk.
  - **It carries forward.** It applies to the crates.io 2.14.1 and 2.16.1 packages with
    `patch -d vendor -p1 --fuzz=0`, at offsets of up to 53 lines. Built with it, each version
    passes 1311 of 1311.
  - **Undoing a site is mostly loud.** Undoing one of the ten backend and identity sites fails
    100 to 738 tests. An iterator site fails to compile, and the stubs edit fails to link.
  - **One site is silent.** The delete-by-range pair (`table.rs:275`/`:279`) fails no test,
    because no production code deletes by range. The Fixture defines no
    `datastore_delete_by_index_scan_range_bsatn`, so the first reducer that does will fail the
    test link until the Fixture models it.
- **The temp workspace of `account-e2e`.** `evals/account-e2e.eval.mjs` copies the workspace
  into a temp directory by fixed lists (`WORKSPACE_MEMBERS` and `WORKSPACE_ROOT_FILES`, lines 88
  to 95, copied at lines 2690 to 2699). Without `vendor/` there, the `[patch]` paths do not resolve.
  This was read from the code, not run: the eval starts a host, and a 2.12.0 host stamps the
  shared data directory.
- **Limits.**
  - **Procedures still refuse natively.** `ProcedureContext` keeps its native-only branches:
    `src/lib.rs:1563` and `:1609` panic, `:1808` panics in `try_with_tx`, and procedure HTTP
    returns an error (`src/http.rs:559`). The module declares no procedure. The first slice that
    tests one natively extends the patch the same way (an attribute that sends native code down
    the wasm branch, with its notice). It also adds the `procedure_*` host functions to the
    Fixture.
  - **The native cdylib links on Linux only.** The upstream stubs define every host function
    natively. With them, a native cdylib has no undefined host function, so it links even where
    the linker refuses undefined symbols, as on macOS and Windows. Under B it has 19, as it did
    on 2.11.0. Not measured on those systems.
  - **The fork ends when the vendor ships an alternative.** That is either a native host the
    generated code reaches through the ABI, or a `test-utils` datastore that reports a
    transaction's writes and runs the shipped views. Then this decision is judged again.

### Ruled out

- **B1, the stubs switched off and nothing else.** It links; 542 passed and 769 failed, because
  of change 2 above.
- **A linker flag that tolerates the duplicates.** `-Wl,--allow-multiple-definition` links, and
  the vendor's stubs win: 769 fail (lpw-34, note n2). lpw-39.2 also forbids any such flag.
- **Tests on crate 2.11.0 while the module ships on a later one.** This breaks "SpacetimeDB
  versions move in lockstep": the crate version is the product version.

## The cost of a test run, measured on crate 2.12.0

| Build | Build (s) | Run (s) | Run ratio | Target dir (GB) | Cargo.lock packages | Passed | Failed |
|---|---|---|---|---|---|---|---|
| 2.11.0 today | 38.30 | 2.652 | 1.00 | 1.9 | 184 | 1311 | 0 |
| A | 86 | 34.930 | 13.17 | 5.5 | 673 | 1108 | 203 |
| B | 40.62 | 2.744 | 1.03 | 1.9 | 184 | 1311 | 0 |
| B1 | not measured | 4.490 | 1.69 | not measured | 184 | 542 | 769 |

- **Run ratio** is the row's run time over the 2.11.0 row's.
- **A's run** is slower because each `fixture()` builds a fresh `RelationalDB` holding the
  module's 72 tables. Its run time is a lower bound: 203 tests stop at their first panic. It was
  built and run with `--lib`, which its cdylib needs.
- **A's build** time (cargo reports `1m 26s`) includes the V8 download.
- **B1** was built into a target directory that already held 2.12.0's dependencies, so it has no
  cold figure.

## The judge

A `judge` scored the two alternatives against a rubric whose weights and tie-break were fixed
before scoring, using the probe logs and the vendor sources:

| Criterion | Weight | A | B |
|---|---|---|---|
| Keeps the Fixture's API and every server-module test's assertion | 30 | 4 | 30 |
| The host answers what the tests ask, as the real host would | 20 | 11 | 12 |
| Release artefact and supply chain | 20 | 10 | 12 |
| Cost of a test run | 15 | 2 | 14 |
| Work at each SpacetimeDB hop | 15 | 8 | 10 |
| **Total** | 100 | 35 | 78 |

The tie-break (fewer server-module assertions changed, then the smaller difference in the shipped
artefact) applies within five points, so it does not decide here. The reasons, by criterion:

- **API and assertions.** A keeps the signatures in name only: 203 tests fail, and the walls stop
  aborting anything. B keeps all 1311.
- **Fidelity.**
  - A gains the vendor's real constraint, sequence and schema checks, which no current test
    needed. But it runs the crate's test-only backend branch, not the one that ships, and it
    loses `Table::delete(row)`, JWT-less connections and every test-strength feature.
  - B runs the shipped `sys` branch and keeps those features. Its model is still partial: unique
    constraints are opt-in, there is one sequence column per table, and there is no rollback.
- **Supply chain.** A adds 489 packages and a network-fetched V8 binary to the test build. B adds
  no third-party package to the build, and the module it ships is the vendor's code. But it takes
  the two crates out of `cargo audit`'s scope.
- **Cost.** A's runs take 13 times as long, it needs 2.9 times the disk, and it forces `--lib` onto
  the test commands. B is at parity with 2.11.0.
- **Hops.**
  - A carries no fork, but the hidden constructor it builds on changes at 2.14.1.
  - B re-applies one patch at each hop.

The hop score for B credited a missed edit failing loudly. One site, delete by range, fails no
test, and the guard covers it. That changes no ranking: the margin is 43 points.

## The choice

**B: the two vendor crates, patched where they refuse a native host.**

- It is the only alternative that keeps the Fixture's public API, which lpw-39's contract
  requires, and every server-module test with it.
- Its test runs cost what they cost on 2.11.0.
- The module it ships is the vendor's code.

A, by contrast, gives up the counters, the wall and the views that 203 of the tests rest on. It
also takes 13 times the run time and brings 489 more crates.

**It lands as lpw-34's first lockstep hop, to 2.12.0, not on 2.11.0.**

- Neither alternative exists at 2.11.0: that version defines no stubs to switch off and has no
  `test-utils` feature.
- lpw-39.2 is a criterion on crate 2.12.0.

So the hop moves the CLI, the host, the crate and the npm SDK to 2.12.0 together, by
`docs/runbooks/spacetimedb-upgrade.md`:

- The npm SDK 2.12.0 was published on 2026-10-13, so it is past the 7-day cooldown. It declares
  no `engines` field, so Node 24.22.0 serves.
- The CLI's sha256 for CI is
  `154853dd882abe1e6f8b96e169f9ca43a075df006dd33116b85d03c59a912f89` (lpw-34's note).

## The patch

Both crates are copied from their crates.io 2.12.0 packages into `vendor/spacetimedb` and
`vendor/spacetimedb-bindings-sys`. Each copy omits its `Cargo.lock`. Then these
attributes change, and nothing else does. Line numbers are those of 2.12.0, and the patch does
not shift them.

| Crate | File | Lines | From | To |
|---|---|---|---|---|
| `spacetimedb-bindings-sys` | `src/lib.rs` | 990 | `#[cfg(not(target_arch = "wasm32"))]` | `#[cfg(any())]` |
| `spacetimedb` | `src/table.rs` | 61, 108, 136, 162, 184, 217, 244, 275, 299, 1867, 1879, 1931 | `#[cfg(target_arch = "wasm32")]` | `#[cfg(all())]` |
| `spacetimedb` | `src/table.rs` | 65, 112, 140, 166, 188, 222, 248, 279, 303, 1869, 1881, 1950 | `#[cfg(not(target_arch = "wasm32"))]` | `#[cfg(any())]` |
| `spacetimedb` | `src/lib.rs` | 1231 | `#[cfg(target_arch = "wasm32")]` | `#[cfg(not(all(feature = "test-utils", not(target_arch = "wasm32"))))]` |
| `spacetimedb` | `src/lib.rs` | 1244 | `#[cfg(all(not(feature = "test-utils"), not(target_arch = "wasm32")))]` | `#[cfg(any())]` |

`#[cfg(all())]` is always on and `#[cfg(any())]` always off. So, on wasm and on a native build
without `test-utils`:

- each table operation takes the branch wasm takes, which calls `sys`;
- `database_identity()` reads the `identity` host function;
- the stubs module is gone.

Each changed line ends with its notice, `// monster-realm: was <the original attribute>`. The
crates are Apache-2.0, whose §4(b) asks that a changed file say so. A notice at the end of a line
moves no line, so the panic locations the module embeds stay the same. The four hashes above were
built with the notices in place.

The files that hold the patch:

- **`vendor/native-host.patch`.** The unified diff of these lines, notices included: 16 hunks and
  27 added lines. Its paths are relative to `vendor/` (`a/spacetimedb/src/table.rs`,
  `a/spacetimedb-bindings-sys/src/lib.rs`), and a hop applies it once, with
  `patch -d vendor -p1 --fuzz=0 --no-backup-if-mismatch < vendor/native-host.patch`, then
  regenerates it if a hunk applied at an offset (the runbook's "Re-vendor the two patched crates").
- **`vendor/PRISTINE.sha256`.** For each crate, a `crate <name> <version> <cksum>` line (the
  crates.io index `cksum` of its `.crate` file), then the sha256 of every file in the unpacked
  package, before the patch, with the omitted `Cargo.lock` marked `omitted`.
- **`vendor/README.md`.** What the directory holds and why, which files the patch changes, the
  license notice, and how a hop re-vendors.

### The guard

`native_host_tests.rs` holds one test, `nh_vendored_crates_are_the_crates_io_release_plus_the_patch`.
It reads `CARGO_MANIFEST_DIR/../vendor` and the root `Cargo.toml`, and its first failing check is
the error:

- **Provenance.** It undoes each hunk of `vendor/native-host.patch` in memory, strictly: a hunk
  whose new lines are not in the tree, or whose line counts disagree with its header, fails. It
  then requires every file's sha256 to equal its line in `vendor/PRISTINE.sha256`.
- **No extra or missing files.** The files under each copy are exactly the manifest's, and no
  `omitted` file is present; `vendor/` itself holds only the two copies, `README.md`,
  `native-host.patch` and `PRISTINE.sha256`.
- **The patch changes `#[cfg]` attributes only.** Each changed line pairs `-<ws>#[cfg(A)]` with
  `+<ws>#[cfg(B)] // monster-realm: was #[cfg(A)]`, nothing else on the line; `A` and `B` parse as
  cfg predicates over `target_arch` and `feature` only; and on wasm32, under every on/off choice of
  the features they name, `B` selects what `A` selected. So a `+` line cannot carry code, and the
  shipped module stays the vendor's code.
- **What cargo builds is what it checked.** Each `crate` line's version equals its copy's
  `Cargo.toml`, the `[workspace.dependencies]` pin is exactly `spacetimedb = "=<that version>"`,
  and `[patch.crates-io]` lists exactly the two crates, each at `vendor/<name>`.

It treats each crates.io package as an artifact that a tool generated: it recovers the package's
bytes and compares them, by hash, with the ones recorded from the release. `standards/testing-tdd.md`
calls that regenerate-and-diff, not a scan of hand-written text. What it protects is the provenance
of code the module ships, which no behaviour test can see.

It uses `sha2`, already a dev-dependency of the module. `PRISTINE.sha256` is written only by the
hop step that downloads each `.crate` and checks it against the index `cksum`. So an edit to a copy
shows up in review as a change to the patch or to the manifest. If a hop forgets the patch, or the
pin and the copies disagree, cargo drops the patch. The vendor's stubs then break the test link.

### Measured on the probe

With the workspace pin `spacetimedb = "=2.12.0"` and this `[patch.crates-io]`:

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
| `cargo nextest run -p monster-realm-module --features spacetimedb/unstable` | 1311 | 0 |

No test failed on the probe, so there is no failing test to name. Everything else that ran also
passed:

- `cargo test --doc --workspace`;
- `cargo clippy --workspace --all-targets --all-features -- -D warnings`;
- the 14 evals other than `account-e2e`, with the 2.12.0 CLI first on `PATH` and the regenerated
  bindings (so `bindings-drift` compared against a 2.12.0 `generate`).

The other legs of the hop were measured too, without starting a 2.12.0 host:

- **Bindings.** `spacetime generate` from the 2.12.0 CLI changes one generated file,
  `client/src/module_bindings/index.ts`, and in it only the two CLI-version stamps.
- **The npm SDK at 2.12.0.** `npm run typecheck` passes, and `npm test` passes 6491 of 6492. The
  one failure is under "Tests whose assertion changes".
- **Not run.** None of these ran on a 2.12.0 host, because each one starts one:
  - the e2e suite;
  - `account-e2e`;
  - `smoke-republish`, which parses the CLI's `sql --format json` output;
  - the nightly jobs.

## The hop to 2.12.0, as built

The hop is the patch and its guard, the version moves the runbook lists, and every statement that
names 2.11.0 as the version in use. A statement that records something measured on 2.11.0 keeps
its version, for lpw-34 to re-measure: `docs/e2e-flakes.md` (the host its recipes ran on at
`218e6020`), the 2.11.0 measurements in `docs/local-play.md`, the 2.11.0 comment in
`scripts/smoke-republish.sh` and the runbook's standing facts.

It ran alone, and switched the CLI only inside its own shell: the 2.12.0 binaries, from the
release tarball whose sha256 `scripts/ci-tools.sh` pins, first on `PATH`; `HOME` and the XDG
directories pointed at a scratch directory; `RUSTUP_HOME` and `CARGO_HOME` exported. A newer host
stamps the data directory it starts on, after which a host of the earlier version refuses it (the
runbook's step 6). The e2e job in CI is the live two-client e2e that the lockstep entry requires
for an SDK bump. No proptest seed is committed.

| File | What changed |
|---|---|
| `Cargo.toml` | the pin is `spacetimedb = "=2.12.0"`, the `[patch.crates-io]` table above is added, and the pin's comment states both |
| `Cargo.lock` | the seven `spacetimedb*` packages at 2.12.0; the two patched ones are path packages; 184 packages, as before |
| `vendor/spacetimedb/**` | new: the crates.io 2.12.0 package with the patch, less `Cargo.lock` |
| `vendor/spacetimedb-bindings-sys/**` | new: the crates.io 2.12.0 package with the patch, less `Cargo.lock` |
| `vendor/native-host.patch` | new: the patch |
| `vendor/PRISTINE.sha256` | new: the crates.io checksums and per-file hashes |
| `vendor/README.md` | new: what the directory holds, the change notice, how a hop re-vendors |
| `.gitattributes` | `vendor/** -text`, so that no line-ending normalisation changes a byte the hashes cover |
| `server-module/Cargo.toml` | the dependency comment names the version and the patched copies |
| `server-module/src/native_host_tests.rs` | the guard test; comments only otherwise: the citations into the 2.11.0 sources point at `vendor/` for the two patched crates and at the crates.io 2.12.0 packages for `spacetimedb-sats` and `spacetimedb-primitives` |
| `evals/account-e2e.eval.mjs` | `WORKSPACE_NON_MEMBER_DIRS`, beside `WORKSPACE_MEMBERS`: the non-member directories its temp workspace copies, holding `vendor` |
| `scripts/ci-tools.sh` | `SPACETIME_VERSION=2.12.0` and its sha256 |
| `client/package.json` | `"spacetimedb": "^2.12.0"` |
| `client/package-lock.json` | the SDK at 2.12.0 |
| `client/src/module_bindings/index.ts` | regenerated by `just gen` (the CLI-version stamps) |
| `client/src/net/authToken.test.ts` | the SDK-drift needle and that test's title (under "Tests whose assertion changes"); two comments now say the message carries the status and the client counts every rejection alike |
| `client/src/net/authToken.ts` | the comments that quote the SDK's rejection message and cite its `dist` lines (built at `dist/index.mjs:5219`, thrown at `:5247`), the two that called the message the same for every status, and the `errorFromEvent` (`:6343`) and token (`:6214`, `:7059-7060`) citations |
| `docs/runbooks/spacetimedb-upgrade.md` | the current pin; a `vendor/` row in "What moves together"; step 2 re-vendors before `cargo check`; the section "Re-vendor the two patched crates" (download and check each `.crate`, write `PRISTINE.sha256`, apply and regenerate the patch, pin, read the advisories) |
| `docs/DECISIONS.md` | the lockstep entry's version; the test-host entry to the built state |
| `ARCHITECTURE.md` | the server-tests row (the host runs over the patched copies) and a `vendor/` row in the directory map |
| `AGENTS.md` | the toolchain row's version |
| `README.md` | the toolchain table's version and pin, a `vendor/` row in the directory table, and the License section, which names the Apache-2.0 copies under `vendor/` |
| `docs/PLAYTEST.md` | the CLI version it asks for |
| `docs/runbooks/playtest-ops.md` | the CLI version it asks for |
| `docs/local-play.md` | §3's quotation of the `Cargo.toml` pin (line 546) |
| `scripts/playtest-report.mjs` | the comments that call 2.11.0 the pinned CLI, with the `ORDER BY` refusal and the `--format json` envelope re-checked on 2.12.0 |
| `.claude/skills/spacetimedb-reducer/SKILL.md` | the versions it states and the docs.rs link |
| `.claude/skills/spacetimedb-client/SKILL.md` | the versions it states |
| `docs/refactors/native-test-host.md` | brought to the built state |

`docs/e2e-flakes.md` is unchanged: its one version is a measurement (above).

Measured at the build, 2026-11-22, on the same machine:

- **Module tests.** `cargo nextest run -p monster-realm-module --run-ignored all`: 1312 passed of
  1312, the 1311 that passed on 2.11.0 (each name still listed) and the guard. Before the copies
  existed, the guard alone failed. The test binary links with no linker argument, and `nm` finds
  the 18 host functions defined once each, by the Fixture, and in none of the 118 dependency
  rlibs. Each of the guard's checks was watched failing once against a local break of the
  committed tree.
- **Client.** `tsc` passes, and vitest passes 6492 of 6492 on SDK 2.12.0.
- **Bindings.** `just gen` from the 2.12.0 CLI changes only the two CLI-version stamps.
- **Release notes, 2.11.0 to 2.12.0.** Typed database environments; opt-in automatic reconnect
  in the TypeScript SDK (`withAutomaticReconnect()`, off by default, and the client does not call
  it); the `test_utils` harness; rollback-safe system-table additions; HS256 JWTs rejected (the
  `account-e2e` issuer signs ES256); duplicate interval-scheduled calls fixed.
- **Data across the host hop (runbook step 6).** A 2.11.0 host published the module of `master`
  and seeded a starter monster on a scratch data directory. A 2.12.0 host started on the same
  directory, and this module published over it without `--delete-data`, with no migration
  refused. The monster and the 20 species rows survived. `smoke-republish` passed on the 2.12.0
  host.
- **Playtest tooling (step 7).** `scripts/verify-release-reducers.mjs` parses the 2.12.0
  `describe --json`: 66 reducers, no dev reducer.
- **Metrics (step 8).** `/v1/metrics` on 2.12.0 has 8 of the 9 `spacetime_*` families the
  recording rules and dashboard read. `spacetime_scheduled_function_delay_seconds` appears once a
  scheduled function runs, and none had run on that database; the 2.12.0 host binary defines it.
  The Loki and `mr-trace-relay` leg was not run.
- **Advisories.** None for either crate at 2.12.0, from OSV or GitHub.
- **The re-vendor steps.** The runbook's commands, run at 2.12.0 in a scratch directory,
  reproduce `vendor/` byte for byte.

After the hop, lpw-34 starts from 2.12.0, and each later hop re-applies the patch.

## Tests whose assertion changes

No server-module test changes: B keeps every one, and the probe passed all 1311 unchanged.

Of the suites that ran without a host, one test outside the module changes, in the SDK leg of the
hop:

| Test | Reason |
|---|---|
| `client/src/net/authToken.test.ts` :: `SDK-DRIFT (nh4): the spacetimedb SDK still throws the exact token-rejection message string > BITES: dist/index.mjs contains the literal substring "Failed to verify token: ${response.statusText}"` | SDK 2.12.0 adds the HTTP status to the message: its `dist/index.mjs` builds `Failed to verify token: ${status} ${statusText}` (line 5219). So the needle becomes that string, and so does the part of the title that quotes it. `isStoredCredentialRejected` matches on the prefix `Failed to verify token: `, which is unchanged, and every other test in the file passes on 2.12.0. |

`moved-tests:`

- `client/src/net/authToken.test.ts :: SDK-DRIFT (nh4): the spacetimedb SDK still throws the exact token-rejection message string > BITES: dist/index.mjs contains the literal substring "Failed to verify token: ${response.statusText}"` -> `client/src/net/authToken.test.ts :: SDK-DRIFT (nh4): the spacetimedb SDK still throws the exact token-rejection message string > BITES: dist/index.mjs contains the literal substring "Failed to verify token: ${status} ${statusText}"`
