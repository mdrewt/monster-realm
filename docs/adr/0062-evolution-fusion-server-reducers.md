# 0062. Evolution & fusion server reducers: guard ordering, seam placement, growth-writer registration

**Status:** Accepted
**Date:** 2026-07-02
**Slice:** m10b
**Supersedes:** —
**Amends:** —
**Subsystems:** evolution-fusion, ci-gates
**Decision:** Evolution and fusion reducers apply pure game-core transforms with guard ordering (owner→not-in-battle→content/eligibility) and growth-writer registration.


- Status: accepted
- Date: 2026-07-02
- Milestone: M10b (server evolution & fusion reducers)

## Context and problem statement

M10b adds the `evolve` and `fuse` SpacetimeDB reducers that apply the pure
game-core transforms (ADR-0061) inside the server-module. Several non-obvious
design decisions arose during implementation:

1. **Guard ordering** — how to sequence ownership, battle-escrow, and eligibility
   checks in `evolve` / `fuse`.
2. **Bond write omission** — `evolve` updates stats but deliberately skips
   re-writing the bond field.
3. **Seam function placement** — where to put the pure test-seam wrappers
   (`evolve_seam`, `fuse_seam`) relative to the `no-idle-accrual` eval.
4. **GROWTH_WRITERS registration** — `evolve` and `fuse` write derived-stat fields
   (stat_hp etc.); the `no-idle-accrual` eval must be consciously updated.

## Decision

### 1. Guard ordering

Both reducers follow the pattern:
```
require_owner  →  reject_if_in_battle  →  content/eligibility load  →  mutation
```

Ownership is checked first so that a non-owner cannot even discover whether a
monster is in battle (information leakage through error messages). Battle-escrow
guard comes second because it is the server's mechanism to protect monsters that
are mid-combat; checking it before loading expensive content is also efficient.
For `fuse`, both `require_owner` calls precede both `reject_if_in_battle` calls,
and the explicit `a.owner_identity != b.owner_identity` equality check follows
(redundant given the two ownership checks, but explicit for clarity).

### 2. Bond NOT written in `evolve`

`game_core::evolve` carries bond verbatim (ADR-0061 §3 "carry/combine
individuality"). After the transform, `transformed.bond.value()` equals the
pre-evolution `m.bond`. Writing it back is a semantic no-op but would cause the
`no-idle-accrual` eval to flag `evolve` as a growth path for the `bond` field.
The eval's confinement check is correct: if bond were ever mutated by evolution
(e.g., future "evolution boosts bond by 5" mechanic), that write MUST appear in
this file and trigger a conscious GROWTH_WRITERS update. Omitting the no-op write
preserves the eval's ability to catch that future mistake.

### 3. Test seams live in `evolution_tests.rs`, not `evolution.rs`

`evolve_seam` and `fuse_seam` are pure test wrappers that accept an in-memory
`TestEvolutionDb` instead of a live `ReducerContext`. They are declared with
`#[cfg(test)]` scoping and placed in `evolution_tests.rs` (declared with
`#[path = "evolution_tests.rs"] mod evolution_tests`).

**Why not in `evolution.rs`?** The `no-idle-accrual` eval scans all `.rs` source
files that do **not** end in `_tests.rs`. Seam functions inside `evolution.rs`
(even in `#[cfg(test)]` blocks) would be text-scanned and would trigger the
growth-field confinement check because the eval does not strip `#[cfg(test)]`
blocks. Moving the seams to the `_tests.rs` file excluded from the scan is the
correct placement — seam functions ARE test infrastructure.

### 4. GROWTH_WRITERS registration

The `no-idle-accrual` eval carries a fixed `GROWTH_WRITERS` allowlist with a
comment explicitly requiring a conscious update when a new growth writer lands:
> "adding a NEW growth-writer, e.g. for M10 evolution, MUST consciously update
> this list — that is the mechanical enforcement gate."

M10b adds `evolve` and `fuse` to GROWTH_WRITERS with the rationale:
- `evolve` rewrites `derived_stats` fields (stat_hp etc.) from the **target
  species' base stats** — this is a species-change transform, not idle accrual.
- `fuse` creates an **offspring row** with freshly derived stats — also a
  deliberate player-triggered action, not scheduled accrual.
- Neither is reachable from any scheduled reducer (`movement_tick`).

## Considered alternatives

### Bond write: always write all transformed fields
Writing all fields (including bond) from the transformed MonsterInstance is more
uniform and self-documenting. Rejected because it would cause a false-positive in
the `no-idle-accrual` eval, requiring either a weakened eval or a special-case
carve-out. Omitting the no-op write is lower ceremony and preserves the eval's
bite.

### Seams in `evolution.rs` with eval exclusion pattern
Adding a pattern to the eval to skip `#[cfg(test)]` blocks or to add `evolution.rs`
to an exclusion list. Rejected because it weakens the eval's ability to catch
future mistakes (e.g., if a helper function outside `#[cfg(test)]` grows a
stat write). Moving seams to the test file is architecturally correct.

### Both seams and reducers in a single file with feature flag
Using `#[cfg(feature = "test-seams")]` to conditionally expose seams as public
symbols. Rejected: adds unnecessary build complexity and no benefit over the
established `#[path] mod` pattern used in the rest of the server module.

## Consequences

- The evolve/fuse guard ladder (owner → battle → eligibility → mutation) is the
  canonical pattern for M10+ reducers that operate on escrowable entities.
- The `no-idle-accrual` eval's GROWTH_WRITERS list now includes `evolve` and
  `fuse`; any future reducer that modifies bond, EVs, or derived stats MUST be
  added to this list with a comment explaining it is not idle accrual.
- Test seams for future reducers that write growth fields should follow the
  `_tests.rs` placement pattern established here.
