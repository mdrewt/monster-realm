# 0043. CI caching + fast inner loop
- Status: accepted
- Date: 2026-06-26

## Context and problem statement

Run #11 measured: the loop ran the full `just ci` 8 times and every compile was
cold (no `sccache`, no `Swatinem/rust-cache`; `cargo-audit` compiled from source
each CI run). Each later slice would repeat this ~10-15 min penalty. The inner
dev loop also lacked a fast, crate-scoped gate for red-green iteration.

## Considered alternatives
- Option A — Shared `CARGO_TARGET_DIR` across worktrees. Rejected: path/fingerprint-keyed
  stale-artifact bugs and lock contention between parallel builds.
- Option B — Content-addressed `sccache` locally + `Swatinem/rust-cache` in CI (deps
  only) + prebuilt binary installs + `cargo-nextest` for parallel test execution +
  `ci-fast <crate>` recipe. Chosen.
- Option C — Self-hosted / larger runners. Deferred: higher maintenance burden for
  marginal gain over caching.

## Decision outcome
- Chosen: Option B, because it accelerates both local and CI builds without
  sharing mutable artifact directories (no staleness risk), keeps workspace
  crate artifacts always-rebuilt, and the `ci-fast` recipe gives a tight red-green
  feedback loop scoped to a single crate.
- Consequences:
  - `just test` now requires `cargo-nextest` on PATH (CI: `taiki-e/install-action`;
    local: pre-installed or `curl -LsSf https://get.nexte.st/latest/linux | tar zxf -`).
  - `just test` runs both `nextest run` (unit/integration, parallel) and `cargo test --doc`
    (doctests, which nextest cannot run).
  - `sccache` is opt-in locally via `eval "$(just cache-on)"` — contributors without
    sccache installed are unaffected (no committed `.cargo/config.toml` rustc-wrapper).
  - CI uses `Swatinem/rust-cache@v2` with per-job `prefix-key` (`v1-ci`, `v1-e2e`) to
    prevent cross-job cache pollution.
  - `taiki-e/install-action@v2` replaces `cargo install` from source for `cargo-audit`
    and `cargo-nextest` in CI (prebuilt binaries, seconds vs. minutes).
  - A `cache-freshness` eval (proof-of-teeth) asserts the caching invariants structurally:
    no shared `CARGO_TARGET_DIR`, `rust-cache` present without `cache-all-crates: true`,
    distinct per-job `prefix-key`, `CARGO_INCREMENTAL=0` with sccache, no committed
    `.cargo` rustc-wrapper, nextest+doctest in `test` recipe, `ci-fast` recipe present,
    `install-action` for audit+nextest.
