# ADR-0076 — Gate & sim-harness teeth (M12.5f)

**Status:** Accepted  
**Date:** 2026-07-03  
**Slice:** M12.5f (sixth-review residuals, gate & sim-harness hardening)

## Context

M12.5 code review produced five residual action items requiring structural hardening across the eval gate, the sim-harness, game-core tests, and the client:

1. **sim-harness used a hardcoded stub map** (`zone_0()`) with no warp tiles — the convergence driver and `tick_zone` were blind to warp geometry in real content.
2. **`spacetime-type-snapshot` eval was missing** — `SpacetimeType` structs/enums carry load-bearing wire-format tag order (variant position = tag index; field position = wire offset) with no snapshot gate to detect silent breakage.
3. **`run.mjs` silently exited 0 on zero evals found** — a broken `cwd` or checkout would produce a false-green CI report.
4. **`dom-shell-coverage-exclusion` parsed shell paths through comments** — a shell referenced only in a `// comment` would appear to be excluded when it wasn't.
5. **`unknown_skill_id_panics` was tautological** — bare `#[should_panic]` + trailing `panic!("...")` passes for ANY panic; the expected message was never checked.

## Decision

### 12.5f-1 — sim-harness real content + warp resolution

`tick_zone` (in `sim-harness/src/world.rs`) now mirrors `movement_tick` warp resolution: after each `apply_move`, if `prev != ch.state.pos`, call `map.warp_at(pos)` and if `Some(warp)`, update `zone_id`, `to_tile`, clear queue, set Idle. Battle-guard is omitted (harness has no battle tables).

`lib.rs` now loads real content via `load_zone_maps()` / `map_for()` instead of the hardcoded `zone_0()` stub. A `warp_scenario()` helper (E×2,S×3,E×2,S from spawn — navigating around the wall pair at (4,3)/(5,3) in the zone 0 RON) crosses the warp tile at (5,5) and the convergence test asserts forward vs. reversed delivery order yields the same final `TilePos`.

`game-core/src/world.rs` gains `zone_0_matches_authored_ron` — a REAL drift test comparing `zone_0()` against the authored RON via `load_zone_maps()`. The existing `map_for_zone_0_matches_zone_0_art` was tautological (it compared `zone_0()` against a constant derived from `zone_0()`'s own row data).

### 12.5f-2 — `spacetime-type-snapshot` eval

New eval `evals/spacetime-type-snapshot.eval.mjs` and baseline `evals/baselines/spacetime-types.json`.

The eval parses all `#[derive(SpacetimeType)]` and `#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]` definitions from `server-module/src/**` and `game-core/src/**`. It snapshots:
- **Structs**: ordered `[field_name, type]` pairs (field position = wire offset).
- **Enums**: ordered variant names (variant position = tag index).

The baseline covers 14 types: `ActionState`, `Affinity`, `BattleMonster`, `BattleOutcome`, `BattleSide`, `BattleState`, `Direction`, `EncounterEntryRow`, `MoveInput`, `NatureKind`, `StatBlock`, `StatKind`, `TileKind`, `TilePos`.

Proof-of-teeth: a doctored `BattleOutcome` with a `Draw` variant appended must fire RED. The eval uses only literal `/regex/` patterns — no `new RegExp(string)` (Semgrep `detect-non-literal-regexp` compliance).

### 12.5f-3 — eval runner hardening

`run.mjs`: zero eval files found → `process.exit(1)` with an explicit error message (was `process.exit(0)` — a silent blind spot).

`dom-shell-coverage-exclusion.eval.mjs`: `findMissingExclusions` now strips `//` and `/* */` comments from the `vite.config.ts` source before searching for shell paths. Proof-of-teeth T3: a shell path appearing only inside a `//` comment must be flagged as missing from the real exclusion list.

### 12.5f-4 — `unknown_skill_id_panics` narrowed

`game-core/src/combat/resolve.rs`: `unknown_skill_id_panics` changed from bare `#[should_panic]` + trailing `panic!()` to `#[should_panic(expected = "skill id 9999 not found in skills registry")]` with the trailing `panic!` removed. The `expected =` string is sourced from the actual panic site (line 48 of `resolve.rs`). Any change to the panic message now makes this test red.

### 12.5f-5 — recruit e2e condition update + bait arg wiring

`spec-gap-revival.eval.mjs` gains `EXPIRED_FIXME_MILESTONES` (`['M9c', 'M8.7e']`) and `hasExpiredFixme(specSrc, tokens)` (both exported for gate-teeth). The eval scans all `client/e2e/*.spec.ts` files and fails if any `test.fixme`-bearing file still references a merged milestone token.

`client/e2e/recruit.spec.ts`: updated header to document the real current blocker — `M12.5-recruit` infra (dev_reducers `--bin-path` publish not CI-wired). The expired "M9c" milestone token is removed from the file; the condition now references only the pending infra slice.

`client/src/main.ts`: `refreshBattle()` now builds `baitItems: BaitItem[]` from `store.ownInventory()` × `store.itemDef()` (classify by `recruitBonus`, ADR-0047) and passes it as the fourth argument to `buildBattleViewModel()`. This was the missing bait-arg wiring that deferred recruit-UI testing.

## Consequences

- **Sim-harness** now exercises real warp geometry, making convergence tests sensitive to actual map changes.
- **SpacetimeType snapshot** gates wire-format regressions across 14 types; re-baseline is required whenever a SpacetimeType evolves (intentional friction for breaking changes).
- **Zero-eval guard** prevents a broken checkout from producing a false-green eval report.
- **Comment-stripping** in coverage-exclusion prevents shell paths that are only in comments from appearing excluded.
- **`expected =` on `should_panic`** narrows the panic gate to the exact message; changing the panic string requires updating the test.
- **Bait arg wired** in `main.ts`; recruit e2e fixmes now reference the actual remaining blocker (infra, not UI).

ADR next-free: **0077**
