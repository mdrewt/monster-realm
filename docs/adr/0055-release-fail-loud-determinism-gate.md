# 0055. Release fail-loud + determinism-gate completeness (overflow-checks + RNG/clock sinks)

- Status: accepted
- Date: 2026-06-28
- Milestone: M8.8a (fourth-review residuals)

## Context and problem statement

Two critical determinism/correctness gaps shipped in released/bench artifacts (the wasm prediction package, the SpacetimeDB cdylib, criterion benches):

**Problem A:** The workspace had no `[profile.release]` or `[profile.bench]` overflow-checks settings. Debug/test builds panic on integer overflow (Rust default), but release/bench builds silently wrap. A true overflow caught by test suite passes in release, an integer-overflow-as-logic-bug ships to production. This divergence violates ADR-0003 (determinism SSOT: debug and release must behave identically). The known reachable overflow (recruit-path turn_number wrapping to Fled) was fixed by merged M8.8b; enabling this aborts no reducer, and future overflows fail loud instead of silently.

**Problem B:** The workspace `clippy.toml` determinism gate (ADR-0003) banned `std::time::*` + `rand::thread_rng`/`random` but left a gap: it did NOT ban the OS-entropy sinks present in the resolved dependency graph.

- `getrandom` 0.3 (`fill`) + 0.2 (`getrandom` fn) — pulled in by `rand` + `chrono`
- `rand` 0.9 `rng()` alias (unseeded RNG, distinct from seeded `rand::rngs` constructor patterns) — not caught by the existing `thread_rng`/`random` bans
- `rand::rngs::OsRng` + `rand::rngs::ThreadRng` (type constructors, not method calls) — not covered by `disallowed-methods`, only `disallowed-types`
- `chrono::Utc::now()` + `chrono::Local::now()` (wall-clock reads) — orthogonal to `std::time`

A clean `just lint` gave false confidence; the bans were incomplete. The ADR-0003 EARS ("every path that reads time or draws RNG without injection") were not fully wired.

## Decision outcome

### 1. Add `[profile.release] overflow-checks = true` and `[profile.bench] overflow-checks = true` to workspace Cargo.toml

Release/bench builds now panic on integer overflow, matching debug/test. In SpacetimeDB a panic = reducer abort = transaction rollback, which is the intended fail-loud posture for uncaught arithmetic bugs. The workspace profile settings are honored by all member crates (feature-isolated, ADR-0036).

### 2. Broaden `clippy.toml` disallowed-methods and add disallowed-types

**New disallowed-methods entries** (with `allow-invalid = true`):

- `getrandom::getrandom` (0.2 name, removed in 0.3; clippy still reports the canonical path)
- `getrandom::fill` (0.3 name)
- `rand::rng` (rand 0.9 unseeded-RNG alias, distinct from seeded construction)
- `chrono::Utc::now`
- `chrono::Local::now`

**New disallowed-types entries** (with `allow-invalid = true`):

- `rand::rngs::OsRng` (OS entropy type, constructor)
- `rand::rngs::ThreadRng` (unseeded thread RNG type, constructor)

**Rationale for `allow-invalid = true`:** Clippy resolves disallowed paths against each crate's reachable dependency graph. A banned path not reachable from a given crate (e.g., chrono in a crate that doesn't depend on it) would otherwise emit "does not refer to a reachable function/type" noise on every fresh lint. `allow-invalid` silences that noise. However, it also silences a typo'd/renamed ban path, making the ban silently inert. The safety is restored by the proof-of-teeth fixture (Part A below): a typo'd ban path is NOT rejected by clippy on the fixture → the eval goes RED.

**std::time::* stays loud** (no `allow-invalid`): `std` is always reachable, so there is no noise to silence; an inert ban would be a compile error, catching a typo immediately.

### 3. Proof-of-teeth: determinism-fail-loud.eval.mjs wired into `just eval` / `just ci`

The gate must demonstrably BITE. Three orthogonal checks:

**Part A — Clippy rejects every banned sink in a detached fixture**

- **Fixture crate:** `evals/determinism-teeth/` (DETACHED, not in workspace members)
- **Source:** deliberately calls every banned sink (`std::time`, `chrono`, `rand`, `getrandom`, `OsRng`, `ThreadRng`)
- **Eval:** runs real `cargo clippy` on it with `CLIPPY_CONF_DIR=<workspace root>` so the workspace `clippy.toml` applies, then asserts clippy rejects all 11 method + 2 type bans by matching "disallowed method `<path>`" + "disallowed type `<path>`" in stderr
- **Fixture design (detached):** so `just lint` (`cargo clippy --workspace`) never compiles it; its rand/chrono/getrandom deps never enter the root `Cargo.lock`. A typo'd/removed ban path does NOT fire → Part A reports gate-did-not-bite, goes RED
- **Dependencies:** pinned (=0.9.4 rand, =0.4.45 chrono, =0.3.4 getrandom, =0.2.17 getrandom02 alias for the 0.2 API)

**Part B — Release build aborts on integer overflow**

- **Fixture crate:** `evals/release-overflow-teeth/` (WORKSPACE MEMBER, inherits `[profile.release]`)
- **Test:** `#[should_panic(expected = "overflow")]` test does deliberate u8 overflow via `core::hint::black_box` (defeats const-folding)
- **Eval:** runs `cargo test --release -p release-overflow-teeth` and asserts it passes
  - With overflow-checks on (the fix): overflow panics → `#[should_panic]` catches it → test PASSES
  - Without overflow-checks: overflow wraps → `#[should_panic]` sees no panic → test FAILS
- **Discriminator:** the eval checks if the test actually ran (looks for "test result:" or "did not panic" in output) to distinguish a real test failure (gate-missing) from a build/env error (different fix)

**Part C — Static structural completeness checks** (cheap, fail-fast)

- Comment-stripped `clippy.toml` contains `path = "<required>"` entries for all 11 methods + 2 types
- Comment-stripped `Cargo.toml` contains `[profile.release]` + `[profile.bench]` sections, both with `overflow-checks = true`
- Proof-of-teeth for part C (since benches have no harness in this project): static regex-free pattern matching (indexOf only; no new RegExp for Semgrep ReDoS gate) on comment-stripped config files, with in-file fixtures that exercise every predicate against known-bad input (missing bans, missing sections, commented-out keys, etc.)

### 4. Integration

Eval is registered in `evals/run.mjs` (auto-discovery) and wired into `just ci` via the ci job's `just eval` step.

## Consequences / tradeoffs

- **Positive:** Determinism gate now closes the complete ADR-0003 EARS surface (every unseeded RNG / wall-clock / OS-entropy path). Release/bench artifacts fail loud on overflow, matching debug/test. False-confidence `just lint` is replaced with a proof-of-teeth eval that BITES.

- **CI cost:** The eval compiles the detached fixture's rand/chrono/getrandom once per fresh ci job run (bounded; cached locally). Cost is acceptable for correctness assurance.

- **Scope of bans:** The bans apply under `just lint --all-features`, so `dev_reducers`-gated code (M8.7b ADR-0054) is held to determinism too. Intended.

- **Deferred / named (out of scope):** 
  - **`fastrand`:** 2.4.1 is in `Cargo.lock` but TRANSITIVE-only (proptest → tempfile → fastrand). Not callable from workspace code today. Banning `fastrand::*` would require its entire free-function surface — a half-ban is theatre. Flagged as a follow-up residual, NOT closed here.
  - **`[profile.bench]` effectiveness:** No benchmark harness exists to run, so `[profile.bench]` overflow-checks is statically asserted only (Part C predicate). A future bench infrastructure can validate the behavior.
  - **Accuracy-roll modulo bias:** Remains a spec-named deferral (M8.8d / M9 scope).

## Considered alternatives

- **Use `allow-invalid = false` for all bans** — rejected: would emit "does not refer to a reachable function/type" warnings on every lint for paths not in every crate's dependency graph, polluting the output. The proof-of-teeth fixture (Part A) restores safety against typos.
- **No proof-of-teeth; rely on code review** — rejected: code review catches an accidental import; a missing ban path (due to spec incompleteness or a typo'd path) ships silently. A real eval gate proves each ban is live.
- **Bench overflow-checks omitted** — rejected: the EARS is "fail loud on overflow"; bench artifacts are shipped (published / used in CI), and divergence between release + bench is a correctness bug.
- **Gate only std::time::*; leave OS-entropy open** — rejected: violates ADR-0003. The workspace is deterministic only if all sources of entropy (clock, RNG, OS state) are closed.

## Proof-of-teeth (gates wired, fixtures reject known-bad input)

**evals/determinism-fail-loud.eval.mjs** — pure predicates with in-file teeth:

1. `clippyRejectsAllSinks(stderr, methods, types)` — asserts stderr contains "disallowed method/type `<path>`" for every required path. Tooth: empty stderr returns ok:false.

2. `clippyBansEverySink(clippyToml, methods, types)` — asserts comment-stripped clippy.toml contains `path = "<p>"` for every required path. Teeth: missing ban returns ok:false; commented-out ban returns ok:false (stripTomlComments tested separately).

3. `stripTomlComments(text)` — removes full-line TOML comments. Tooth: input with commented lines outputs with them gone.

4. `profileFailsLoud(cargoToml)` — asserts comment-stripped Cargo.toml contains both `[profile.release]` and `[profile.bench]` sections, each with `overflow-checks = true`. Teeth: missing section ok:false; section present but key missing ok:false; key present but commented out ok:false.

All teeth run first and short-circuit with fail if any is broken (a broken predicate cannot gate anything).

## References

- ADR-0003 (determinism SSOT — all sources of entropy must be injected)
- ADR-0054 (dev-reducer release-gating — M8.7b; sets the scope for M8.8a completeness)
- ADR-0036 (feature isolation, workspace resolver)
