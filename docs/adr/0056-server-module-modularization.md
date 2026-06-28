# 0056. server-module internal module boundary (domain submodules)

- Status: accepted
- Date: 2026-06-28
- Milestone: M8.9a (spike + scaffold); executed by M8.9b (the move)
- Mirrors: harness corpus ADR-0055 (server-module modularization, workstream A)

## Context and problem statement

`server-module/src/lib.rs` is a single flat module of ~2081 production lines
(3512 total incl. ~1160 inline test lines): 15 `#[spacetimedb::table]` structs,
18 `#[spacetimedb::reducer]`s, and 27 helper fns in one namespace, spanning
lifecycle, content-sync, movement, monster-management, battle, and taming.

This throttles the build fleet's parallelism. Under the `touches:`-disjoint
fan-out model (PLAN.md §9, WORKSPACE-PLAN.md §7), the supervisor runs two slices
concurrently only when their `touches:` sets are disjoint. Because all
server-side gameplay lives in one file, every server slice declares
`touches: server-module/src/lib.rs` and is forced **serial** — the bottleneck
observed across M7/M8/M8.5–M8.8. `standards/adr-process.md` requires an ADR to
introduce a new module boundary.

The split is low-risk because the blast radius is internal: **nothing in the
workspace imports `server-module`** (it is the cdylib leaf), and table/reducer
**names are explicit** (`name = character`, …), so a behavior-preserving move
regenerates **byte-identical** TypeScript bindings. The `bindings-drift` +
`schema-snapshot` evals are therefore the behavior-preservation gate.

The one load-bearing uncertainty: do `#[spacetimedb::table]` / `#[reducer]`
**register from a submodule** (not the crate root) on the pinned spacetime
2.6.0? M8.9a is a **gating spike** to answer it before the bulk move (M8.9b).

## Decision outcome

**Full split — GO.** The M8.9a spike (below) proved submodule registration
works, so the crate is split into cohesive domain submodules of the same crate
(not new crates — ADR-0005), NOT the lighter §6 fallback.

### Module map (the canonical `touches:` vocabulary — keep file names stable)

```
server-module/src/
├─ lib.rs          # mod wiring + init / sync_content / on_disconnect (lifecycle)
├─ schema.rs       # the data #[table] structs + row types
├─ guards.rs       # log_reject, validate_name, authorize_move, check_party_size,
│                  #   check_monster_in_party, check_team_coupling, require_owner (NEW)
├─ marshal.rs      # row <-> game-core marshaling helpers
├─ content.rs      # sync_content_inner + seeding helpers
├─ movement.rs     # join_game, enqueue_move, set_move, clear_queue, movement_tick
│                  #   + the movement_tick_schedule scheduled table (kept with its reducer)
├─ monster_mgmt.rs # set_nickname, set_party_slot
├─ battle.rs       # start_battle, start_wild_battle, submit_attack, swap_active, flee,
│                  #   heal_party + begin_encounter/lead_party/write_back_* (~900 lines)
└─ taming.rs       # attempt_recruit, grant_bait, grant_item, consume_one
```

This map is the canonical `touches:` vocabulary: future server-side slices (M9,
M10, …) declare `server-module/src/<domain>.rs` instead of the whole `lib.rs`,
so two slices touching different domains become `touches:`-disjoint and may fan
out. Renaming a module later invalidates downstream `touches:` declarations.

M8.9b also consolidates the per-reducer `owner != ctx.sender` rejection preamble
into `guards::require_owner` (pure de-dup, identical reject + `log_reject`
behavior), and M8.9c extracts each module's inline `#[cfg(test)]` tests to
sibling `*_tests.rs` files.

### The M8.9a gating spike (PASSED — proof recorded in docs/validation-findings.md)

Moved exactly one `#[table(name = config, public)]` + one `#[reducer] clear_queue`
out of `lib.rs` into a **private** `mod schema;`, then:

- `just build` (spacetime build, wasm32 release) — **green**.
- `just gen` (spacetime generate) — regenerated `client/src/module_bindings/`
  **byte-identical** to the committed bindings (zero `git diff`).

Byte-identical bindings ⟺ identical registered schema ⟺ both macros registered
correctly from a (private) submodule. Registration is **inventory-based, not
path-based**. The spike was then **reverted**; M8.9a ships only the empty
scaffold + this ADR (the actual move is M8.9b).

### Two mechanical constraints the spike surfaced (load-bearing for 9b)

1. **Cross-module table access needs the generated accessor trait imported.**
   `#[table(name = X)]` generates a crate-private snake_case trait `X` that
   provides `ctx.db.X()`. A caller in a *different* module than the table must
   `use crate::<mod>::X;` (or `use crate::X;`). In the spike, moving just `config`
   forced 5 call sites to import `use crate::schema::config;`, and the relocated
   reducer needed `use crate::character;`. 9b must re-import the per-table
   accessor traits wherever a `ctx.db.<table>()` call and its table end up in
   different modules. (`cargo check` / `clippy -D warnings` catch every miss.)

2. **A module name MUST NOT equal a table name.** `mod battle;` collides (E0428,
   type namespace) with the `battle` trait generated by `#[table(name = battle)]`
   **while that table is still defined in `lib.rs`**. Resolution: 9b adds
   `mod battle;` **atomically** with relocating the `battle` table into
   `schema.rs` — once the table (and its generated `battle` trait) leaves the
   crate root, `crate::battle` (module) and `crate::schema::battle` (trait) no
   longer collide. M8.9a therefore wires 7 of the 8 modules and ships `battle.rs`
   as an un-wired scaffold file. (No other module name equals a table name.)

### Eval dependency for 9b (prerequisite — NOT done in 9a)

10 evals statically parse **only** `server-module/src/lib.rs` as a single file
(`battle-schema-snapshot`, `battle-reducer-security`, `recruit-reducer-security`,
`dev-reducer-gating`, `dev-reducer-zone-arg-discipline`, `gate-teeth`,
`inventory-single-stack`, `monster-dual-write`, `monster-privacy`,
`zoned-schema`). Moving tables/reducers out of `lib.rs` will RED these until they
glob `server-module/src/**/*.rs` — the pattern 4 evals already use
(`encounter-privacy`, `inventory-privacy`, `wild-individuality-privacy`,
`spec-gap-revival`; the first explicitly notes "future-proof against splits").
**M8.9b must generalize those 10 evals as part of the move.** This makes 9b touch
`evals/` and therefore **serial against the M8.9e content sibling on `evals/`**
(different files — `append-only-ids.eval.mjs` vs these 10 — but the supervisor
sequences `evals/`-touching slices). M8.9a does not touch `evals/`; the eval
suite stays whole because the table/reducer move is reverted.

## Consequences / tradeoffs

- **Positive:** server slices touching different domains become `touches:`-
  disjoint and parallelizable; smaller diffs; tighter blast radius; faster review.
- **Positive:** behavior is provably unchanged — explicit table/reducer names
  make regenerated bindings + the schema snapshot byte-identical (the gate).
- **Negative:** a one-time serial reorg — M8.9's own move slices share `lib.rs`.
  The parallelism payoff is in downstream milestones, not in M8.9 itself.
- **Negative (newly discovered):** 9b must also generalize 10 lib.rs-hardcoded
  evals to multi-file globbing (see above) — extra, non-optional work the spec's
  slice plan did not enumerate; 9b is fan-out-ineligible on `evals/`.
- **Negative (minor):** the `battle` module can only be wired after the `battle`
  table relocates (ordering constraint, above) — naturally satisfied by an atomic
  9b move.

## Considered alternatives

- **Leave `lib.rs` as one file** — rejected: the parallelism bottleneck persists
  and grows with M11–M16's server-side work.
- **Split into more *crates* (e.g. a `battle` crate)** — rejected as YAGNI;
  intra-crate modules suffice and keep the workspace simple (ADR-0005).
- **§6 lighter "logic-in-modules, macros-in-lib.rs" split** — retained ONLY as
  the fallback had the spike failed. The spike passed, so the full split is taken.
- **Rename the `battle` module to dodge the table-name collision** — rejected:
  the spec fixes `battle.rs` as the `touches:` vocabulary; an atomic 9b move
  removes the collision without a rename.

## References

- ADR-0003 (rule SSOT — game-core owns rules; the shell stays thin)
- ADR-0005 (single cohesive cargo workspace + crate boundaries)
- ADR-0006 (additive/zoned schema — this milestone changes no schema)
- ADR-0009 / ADR-0010 (CI gates + proof-of-teeth — bindings-drift + schema-snapshot)
- harness corpus ADR-0055 (server-module modularization, workstream A)
- docs/validation-findings.md (the M8.9a spike record)
- spec: ../../specs/monster-realm-v2/M8.9-server-module-modularization.spec.md
