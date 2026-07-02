# 0064. M10d: evolution/fusion content-integrity evals and proof-of-teeth discipline

- Status: accepted
- Date: 2026-07-02
- Milestone: M10d (evals + doc-keeper; closes Phase A)

## Context and problem statement

M10 adds evolution and fusion mechanics. The game-core `validate_evolution_fusion`
function (ADR-0060, 7 rules) runs at `sync_content` time — but that is a publish-time
check. Content authors can write a self-evolution or a dangling species ref and not
discover it until they push a server build.

M10d wires two new eval files into `just eval` so that content mistakes are caught
**before** any publish cycle, at fast local dev time. Both evals auto-discovered by
`evals/run.mjs` (glob `*.eval.mjs`).

## Decision

### eval 1 — `evolution-fusion-content-integrity.eval.mjs`

Mirrors 5 of the 7 `validate_evolution_fusion` rules as static JS checks against the
live content files:

| Rule | Description |
|------|-------------|
| R2   | No self-evolution (`to_species != species_id`) |
| R3p  | Dangling refs — every species id in evolution/fusion records exists in the species registry |
| R5   | Fusion coherence: `a != b`; `to ∉ {a,b}` |
| R6   | Derived-forms-not-wild — evolution targets ∪ fusion results never appear in encounter tables |
| R7   | No duplicate fusion pair (order-independent `{a,b} == {b,a}`) |

Also verifies that `sync_content` in `server-module/src/content.rs` textually calls
`validate_evolution_fusion` (ensuring the production gate is still wired after future
refactors).

Rules R1 (registry well-formedness/non-empty) and R4 (Bond(0) always-true trigger) are
runtime-only checks in Rust, not mirrored here — calling them out explicitly so future
authors know why.

### eval 2 — `evolution-reducer-security.eval.mjs`

Nine structural invariants (E1–E9) statically checked against the server-module Rust
source (all `*.rs` files under `server-module/src/` concatenated per ADR-0056):

| ID  | Invariant |
|-----|-----------|
| E1  | `evolve` has ownership guard (`require_owner`) |
| E2  | `evolve` has battle-escrow guard (`reject_if_in_battle`) |
| E3  | `fuse` has ownership guard for **both** parents (≥ 2 occurrences) |
| E4  | `fuse` has battle-escrow guard for **both** parents (≥ 2 occurrences) |
| E5  | `fuse` has self-fusion guard (`a_id == b_id`) |
| E6  | `evolve` dual-writes `monster` + `monster_pub` via `pub_from_monster` |
| E7  | `fuse` dual-writes both tables via `pub_from_monster` + deletes parent `monster_pub` rows (×2) |
| E8  | `evolve` delegates to `game_core_evolve` / `game_core::evolve` (SSOT) |
| E9  | `fuse` delegates to `game_core::fuse` / `game_core_fuse` (SSOT) |

### Proof-of-teeth discipline (ADR-0010)

Every gate has at least one known-bad fixture that must be rejected:
- `evolution-fusion-content-integrity.eval.mjs`: 12 fixtures
- `evolution-reducer-security.eval.mjs`: 15 fixtures

The pattern: `const result = checkFn(badFixture); if (result === null)
throw new Error('TOOTH n FAILED ...')`. This proves the detector has teeth before
running on production content/source.

### No `new RegExp(...)` — Semgrep `detect-non-literal-regexp`

All pattern matching uses literal `/regex/` or `String.indexOf()`. `new RegExp(...)`
is banned by the Semgrep rule that has triggered CI failures 3× in this codebase.

## Consequences

- Content mistakes (self-evolution, dangling refs, wild-catchable derived forms,
  duplicate fusion pairs) are caught at `just eval` time, not publish time.
- Reducer security regressions (dropped ownership or battle-escrow guards) are caught
  statically, not only by e2e tests.
- Phase A (M0–M10) is declared complete. All spine milestones are closed.
- `evals/run.mjs` was not modified (structural/serial-only per standing constraint).
- ADR-0063 is reserved for M10c (evolution/fusion client).
