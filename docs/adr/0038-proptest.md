# ADR-0038: `proptest` for property testing the logic-heavy rules

**Status:** Accepted
**Date:** 2026-06-25
**Slice:** m1
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, tooling-docs
**Decision:** Use proptest with seeded strategies for property-testing game-core invariants (totality, determinism, behavioral correctness) across randomized inputs.


- **Status:** Accepted
- **Date:** 2026-06-25
- **Context milestone:** M1 (movement core)
- **Implements:** the `standards/testing-tdd.md` "property tests per rule" mandate;
  PLAN.md §7 (game-core is the test center of gravity)

## Context

`game-core` rules must hold invariants over *all* inputs, not just hand-picked
examples — totality (no panic on extreme `i32` coords), determinism, and
behavioural invariants (step distance ≤ 1, in-bounds preserved, serde round-trip).
Example-based unit tests can't cover that space.

## Decision

Add **`proptest = "1"`** (workspace dev-dependency SSOT) for property/invariant
tests in `game-core`. It is a `[dev-dependencies]` entry only — it never enters the
server module, the wasm client, or any shipped artifact, so it does not widen the
runtime supply chain or touch the feature-isolation graph.

## Consequences

- Each logic-heavy rule ships example tests (the EARS criteria) **and** properties
  (totality/determinism/invariants). M1 movement uses it for `TilePos::step`
  saturation, `apply_move` totality+determinism, and the serde round-trip.
- Future logic milestones (battles, taming, economy) inherit the pattern.
- `cargo-mutants` (the mutation gate, a later slice) complements proptest: proptest
  proves invariants, mutation proves the tests have teeth.
- Considered alternative: `quickcheck` — rejected; `proptest`'s shrinking + strategy
  API is the stronger fit and the harness-standard choice.
