# ADR-0072: fuse offspring monster_pub dual-write ordering fix

**Status:** Accepted
**Date:** 2026-07-03
**Slice:** m12.5a
**Supersedes:** —
**Amends:** —
**Subsystems:** evolution-fusion, ci-gates
**Decision:** Fix fuse offspring dual-write ordering: capture the insert return value and build MonsterPub from the inserted row, preventing monster ID mismatches.


**Status:** accepted  
**Date:** 2026-07-03  
**Deciders:** Drew Teter  
**Slice:** M12.5a

## Context

The `fuse` reducer in `server-module/src/evolution.rs` created a `MonsterPub` projection row
BEFORE calling `ctx.db.monster().insert()`. SpacetimeDB assigns the `auto_inc` `monster_id` at
insert time and returns the row with the real id; discarding that return value and calling
`pub_from_monster` on the pre-insert row produced `monster_pub.monster_id = 0`.

Consequences (all active at `bba7698`):
- Fusion offspring were invisible to clients (clients render from `monster_pub`).
- The SECOND fusion on any live database aborted on the PK-0 collision — fusion permanently
  broken after one use.
- All later dual-writes keyed by the real offspring id missed the pub row.

The `fuse_seam` test double masked the bug by pre-allocating the id before constructing the
`Monster` struct, so `offspring_monster.monster_id` was non-zero when `pub_from_monster` was
called. The seam diverged from production at exactly the buggy line.

Every other creation path in the codebase already used the correct pattern:
- `movement.rs:104-105`: `let inserted = ctx.db.monster().insert(row); pub_from_monster(&inserted)`
- `taming.rs:136-137`: same pattern

## Decision

### 12.5a-1 — Production fix

Capture the insert return value in `fuse`:

```rust
// Before (buggy):
let offspring_pub = pub_from_monster(&offspring_monster); // monster_id==0
ctx.db.monster().insert(offspring_monster);               // return discarded
ctx.db.monster_pub().insert(offspring_pub);               // pub lands with id=0

// After (correct):
let inserted = ctx.db.monster().insert(offspring_monster);
ctx.db.monster_pub().insert(pub_from_monster(&inserted));
```

### 12.5a-2 — Seam alignment

Changed `TestEvolutionDb::insert_monster` to:
- Return `Monster` (the row with the assigned id).
- Auto-assign the id via `alloc_monster_id()` when `m.monster_id == 0`, mirroring
  SpacetimeDB's `auto_inc` behaviour.

Changed `fuse_seam` to set `Monster { monster_id: 0, ... }` (no pre-allocation) and use
`let inserted = db.insert_monster(offspring_monster)` so the seam path is byte-identical in
structure to production.

### 12.5a-3 — Proof-of-teeth gating

**Rust test** `fuse_offspring_pub_id_matches_monster_id` (4 assertions):
- No `monster_pub` row may have `monster_id == 0`.
- HashMap key equals `pub_row.monster_id`.
- `monster_pubs.contains_key(&effect.offspring_monster_id)`.
- `monsters.contains_key(&offspring_pub.monster_id)`.

**Eval teeth D** in `evals/monster-dual-write.eval.mjs`:
Adds constant `CAPTURE_INSERT = '= ctx.db.monster().insert('`. A function body that has
`ctx.db.monster().insert(` WITHOUT capturing the return value (no `= `) is flagged as a
dual-write ordering violation. The bad fixture for TEETH D intentionally omits the capture;
reverting 12.5a-1 makes the eval RED.

## Project-wide invariant (derived)

> **Insert-then-pub:** `ctx.db.monster().insert()` MUST capture the return value. The pub row
> MUST be built from the returned (id-assigned) row via `pub_from_monster`. This is the only
> valid sequence for any `monster`/`monster_pub` dual-write on an insert.

The `monster-dual-write` eval now mechanically enforces this invariant via the `CAPTURE_INSERT`
check (TEETH D).

## Consequences

- Fusion is now correct end-to-end: offspring are visible to clients immediately after fuse,
  and repeated fusion works without PK collisions.
- The seam is faithful to production ordering; seam-passing tests are no longer a false
  assurance of production correctness.
- The eval gate catches any future regression to the uncaptured-insert pattern.
- `TestEvolutionDb::insert_monster` now returns `Monster`; callers that ignored the return
  still compile (Rust ignores unused return values).
