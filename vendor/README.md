# vendor/

Two crates of the SpacetimeDB module SDK, copied from their crates.io packages and patched so that
the server module's tests can run natively against this repository's own host:

| Directory | Package | Version |
|---|---|---|
| `spacetimedb/` | [`spacetimedb`](https://crates.io/crates/spacetimedb) | 2.12.0 |
| `spacetimedb-bindings-sys/` | [`spacetimedb-bindings-sys`](https://crates.io/crates/spacetimedb-bindings-sys) | 2.12.0 |

The root `Cargo.toml` pins `spacetimedb = "=2.12.0"` and points `[patch.crates-io]` at these two
directories. They are not workspace members, so `cargo fmt`, `cargo clippy` and `cargo mutants`
never read them. The other `spacetimedb-*` crates (`-lib`, `-sats`, `-primitives`,
`-bindings-macro`, `-query-builder`) still come from crates.io.

## Why the copies exist

From 2.12.0 the vendor's crates refuse a native host in two places. `spacetimedb-bindings-sys`
defines every host function itself on a non-wasm target (`mod native_link_stubs`), and
`spacetimedb`'s table backend returns `HOST_CALL_FAILURE` on a non-wasm target without calling the
host. `server-module/src/native_host_tests.rs` defines the host functions over an in-memory row
store, so its test binary needs the host calls to reach it. The decision is in `docs/DECISIONS.md`
("Server-module tests run on our own host ABI, over the two vendor crates patched where they refuse
a native host"); the measurements behind it are in `docs/refactors/native-test-host.md`.

## What the patch changes

`native-host.patch` changes 27 `#[cfg]` attributes and nothing else:

| File | Lines (2.12.0) | Change |
|---|---|---|
| `spacetimedb-bindings-sys/src/lib.rs` | 990 | `native_link_stubs` is compiled on no target |
| `spacetimedb/src/table.rs` | 61, 108, 136, 162, 184, 217, 244, 275, 299, 1867, 1879, 1931 | the branch that calls the host is compiled on every target |
| `spacetimedb/src/table.rs` | 65, 112, 140, 166, 188, 222, 248, 279, 303, 1869, 1881, 1950 | the branch that returns `HOST_CALL_FAILURE` is compiled on no target |
| `spacetimedb/src/lib.rs` | 1231, 1244 | `ReducerContext::database_identity()` reads the `identity` host function unless `test-utils` is on natively |

On `wasm32` each patched attribute selects what the original selects, so the published module is
built from the vendor's code. Native code without `test-utils` takes the wasm branch.

## License

Both crates are licensed under the Apache License, Version 2.0; each copy keeps its `LICENSE`. Each
changed line ends with the notice `// monster-realm: was <the original attribute>` (§4(b) of the
license). The rest of this repository is under the MIT license (`LICENSE` at the root).

## Provenance

`PRISTINE.sha256` records, for each crate, the sha256 of its `.crate` file (equal to the `cksum` in
the crates.io index) and the sha256 of every file of the unpacked package. Each copy leaves out the
package's `Cargo.lock`, which cargo ignores outside the workspace root; the manifest marks it
`omitted`. The test `nh_vendored_crates_are_the_crates_io_release_plus_the_patch` in
`server-module/src/native_host_tests.rs` undoes the patch in memory and checks every file against
the manifest, and that no file is missing or extra.

`cargo audit` does not check path packages, so CI's audit does not cover these two crates. The
upgrade runbook reads the vendor's advisories for them at each hop.

## Re-vendoring at a SpacetimeDB upgrade

Each hop copies both crates at the new version and re-applies the patch. The steps are in
`docs/runbooks/spacetimedb-upgrade.md` ("Re-vendor the two patched crates").
