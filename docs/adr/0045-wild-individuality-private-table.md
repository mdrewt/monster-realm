# 0045. Wild individuality: private `battle_wild` side-table (seed-keyed), not columns on the public battle row

- Status: accepted
- Date: 2026-06-27

## Context and problem statement

M8c (grass-encounter spine) begins a wild battle when a player steps onto a tall-grass
tile. The wild monster is **unowned** (it has no `monster` row until recruited in M8d),
so its individuality (IVs + nature) cannot live on a `monster`/`monster_pub` row. M8d's
`attempt_recruit` must rebuild **that exact wild** — the same individual the player
fought — so the rolled individuality must be persisted, associated 1:1 with the battle.

The M8 spec text says to store `wild_ivs`/`wild_nature` "as columns **on the `battle`
row**". But the `battle` table is **public** (ADR-0042, so both participants can
subscribe), and IVs + nature are the **hidden-gene "must-never-leak" data class**
(ADR-0015; the same class the private `monster` table and ADR-0040 split-table mode
exist to protect). Putting raw IV/nature columns on the public `battle` row would place
must-never-leak data on a public table.

ADR-0044 established the private-only visibility mode (mode 2) for the `encounter` table:
a server-only table with no `public` attribute, no projection, and no generated client
accessor.

## Considered alternatives

- **Option A — IV/nature columns on the public `battle` row (literal spec wording).**
  Rejected: places raw hidden genes on a public, client-subscribable table. Also note
  `battle-schema-snapshot.eval.mjs` is a *subset* presence check, so it would NOT flag
  the added columns — the leak would ship green. (The new `wild-individuality-privacy`
  eval adds a tooth that flags any `wild_`/`iv_`/`nature` field on the public `battle`
  table precisely to make this mistake impossible.)

- **Option B — Private `battle_wild` side-table storing the six IV columns + nature +
  species + level (1:1, keyed by `battle_id`).** Correct on privacy, but denormalizes
  the output of a pure function: `roll_individuality(seed: u32) -> (IVs, Nature)` is
  total and deterministic (`game-core/src/monster/rolls.rs`), so the IVs/nature ARE a
  projection of the seed. Storing both the seed's *output* and (implicitly) the seed is
  two representations of one fact (an SSOT smell) and a wider table for the privacy eval
  to police.

- **Option C (chosen) — Private `battle_wild` side-table storing the `individuality_seed:
  u32` (+ `wild_species_id`, `wild_level`), keyed 1:1 by `battle_id`.** M8d rebuilds the
  exact wild by re-calling `roll_individuality(individuality_seed)`. Minimal columns,
  SSOT-clean, fully private (mode 2, mirroring `encounter`/ADR-0044).

## Decision outcome

- **Chosen: Option C.** A new **private** table (no `public`, no projection, no client
  accessor):

  ```rust
  #[spacetimedb::table(name = battle_wild)]
  pub struct BattleWild {
      #[primary_key] pub battle_id: u64,   // 1:1 FK to the public `battle` row
      pub wild_species_id: u32,
      pub wild_level: u8,
      pub individuality_seed: u32,         // roll_individuality(seed) rebuilds the exact wild (M8d)
  }
  ```

- **Why the table is private — and what it actually buys.** The table's primary purpose
  is **exact-rebuild persistence for M8d**, not gene-hiding. A subtle, deliberately
  recorded point: the wild's *derived stats* (`BattleMonster.stats`) ARE published in the
  public `battle.state` `BattleState` (as for any battle opponent under ADR-0042), and
  with known species base stats, known level, and EVs fixed at zero for a fresh wild,
  those derived stats are theoretically invertible to the underlying IVs/nature. So the
  private table does not make the wild's genes *information-theoretically* secret. We keep
  it private anyway because exposing a **raw RNG-derived `individuality_seed`** (the
  splitmix32 input — effectively RNG state) on a public table is strictly worse than the
  already-public derived stats: it hands clients the exact genes with zero computation and
  risks exposing predictable RNG state. Bucketing/hiding the wild's *derived* stats to
  close the inversion channel is a balance/UX decision deferred past the playtest gate
  (YAGNI for M8c); it is a pre-existing property of ADR-0042 battle visibility, not
  introduced here.

- **Determinism coupling (accepted).** Storing the seed couples M8d's rebuild to the
  stability of `splitmix32` inside `roll_individuality`. If that algorithm ever changes,
  an in-flight wild battle would rebuild differently. This is bounded to **one battle's
  lifetime** (a `battle_wild` row is not a persistent saved monster) and is the same
  determinism contract M7's `roll_starter` already relies on. Acceptable.

- **Lifecycle.** `begin_encounter` inserts the `battle_wild` row alongside the `battle`
  row (1:1). M8c does **not** delete it on battle-end (`flee`/win) — M8d owns the recruit
  path that consumes and clears it (YAGNI; speculative cleanup would touch the M7
  battle-end path unnecessarily). A stale `battle_wild` row after a wild battle ends is an
  accepted residual, parallel to ADR-0044's stale-zone-row residual.

- **Wild-battle row shape (consequence of an unowned opponent).** `begin_encounter` builds
  the `Battle` row directly (it does NOT call `start_battle`, so it does not relax that
  reducer's owned-opponent guards): `opponent_identity = WILD_IDENTITY` (a zero-byte
  sentinel no connection holds), `opponent_monster_ids = vec![]` (the wild has no owned
  monster id), and `side_b.team = vec![<one wild BattleMonster>]` (exactly one element so
  `side_b.active_monster()` in `submit_attack`/`flee`/`write_back_battle_results` never
  indexes an empty team). The `side_b.team.len()==1` vs `opponent_monster_ids.len()==0`
  asymmetry is intentional and documented at the table/builder so M8d does not zip them.

- **Spec reconciliation.** This deviates from the M8 spec's literal "columns on the
  `battle` row". doc-keeper updates the M8 spec text to "a private `battle_wild`
  side-table keyed by `battle_id`, storing the rolled `individuality_seed`". The invariant
  (must-never-leak data in a private table) outranks the literal wording.

- **References:** ADR-0044 (private `encounter` table — the mode-2 precedent this mirrors),
  ADR-0042 (battle table public for PvE — why columns on `battle` would leak, and why
  derived-stat visibility is a pre-existing accepted property), ADR-0015 (hidden-gene
  must-never-leak), ADR-0006 (additive schema — a new table, no migration of existing
  rows).

- **Consequences:**
  - **Positive:** Raw wild genes/seed never reach a client at the transport level. M8d can
    rebuild the exact wild from three small columns. SSOT-clean (the seed is the single
    source of the individuality). A new `wild-individuality-privacy` eval (cloning the
    ADR-0044 `encounter-privacy` 6-teeth pattern) mechanically enforces: `battle_wild`
    private + exists, no `battle_wild`-prefixed projection, no RLS bypass, no generated
    accessor, AND no `wild_`/`iv_`/`nature` column on the public `battle` table.
  - **Negative (accepted residuals):**
    (a) **Schema shape in codegen** — `spacetime generate` emits the `BattleWild` field
        shape into `types.ts` (schema metadata, not row data, no accessor/subscription),
        identical to the private `monster`/`encounter` behavior (ADR-0044 residual a).
    (b) **Stale `battle_wild` rows** post-battle until M8d's recruit/end path clears them.
    (c) **Derived-stat inversion channel** — the wild's IVs are theoretically recoverable
        from public derived stats (above); closing it (stat bucketing) is deferred.
    (d) **splitmix32 stability coupling** — bounded to one battle's lifetime (above).

- **Follow-ups:** M8d (`attempt_recruit` reads `battle_wild`, rebuilds the exact wild,
  grants it at full HP, clears the row; inventory + bait + client recruit action).
