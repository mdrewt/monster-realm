# M8c Plan — Review Resolutions (v2, SUPERSEDES conflicting parts of PLAN.md)

Incorporates reviewer + red-team findings. These are binding for the tester + implementer.

## R-A (was B1) — Store `individuality_seed: u32`, NOT IV columns
`roll_individuality(seed) -> (IVs, Nature)` is pure/deterministic, so the seed IS the SSOT. Final table:
```rust
#[spacetimedb::table(name = battle_wild)]            // PRIVATE — no `public`
pub struct BattleWild {
    #[primary_key] pub battle_id: u64,               // 1:1 FK to public battle row
    pub wild_species_id: u32,
    pub wild_level: u8,
    pub individuality_seed: u32,                      // M8d: roll_individuality(seed) rebuilds the exact wild
}
```
**Purpose of the private table is EXACT-REBUILD PERSISTENCE for M8d, not gene-hiding** (the red-team is right: a wild's derived `stats` are already public in `BattleState`, so IVs are theoretically invertible — that is a pre-existing, accepted ADR-0042 property of battle visibility, NOT introduced here). We keep `battle_wild` private because exposing a raw RNG-derived seed (or raw IV bytes) on a public table is strictly worse than the already-public derived stats and could expose RNG state. ADR-0045 records this rationale + the splitmix32-stability coupling (bounded to one battle's lifetime, same contract M7 `roll_starter` relies on).

## R-B (M1) — ADR citations
The private `encounter` precedent is **ADR-0044** (not 0040). Cite: ADR-0044 (private-table precedent), ADR-0042 (battle public), ADR-0015 (hidden-gene must-never-leak). New ADR = **0045**. doc-keeper also fixes the stale "ADR-0040" header comment in `encounter-privacy.eval.mjs`.

## R-C (M2/m5) — Trigger predicate: ONE pure geometry helper; reuse `encounter_triggers`
- New pure helper in `game-core/src/world.rs`:
  `pub fn stepped_onto_grass(prev: TilePos, next: TilePos, map: &TileMap) -> bool { prev != next && map.is_grass(next) }`
  This is the ONLY new predicate. It fires on: non-grass→grass step, **grass→grass step** (valid "enters a NEW grass tile"), jump that MOVES onto grass. It does NOT fire on: bump (prev==next), standstill (prev==next), jump-in-place (prev==next), respawn/teleport (those paths never go through `movement_tick`'s `apply_move` branch). Unit-test every case.
- The probability decision MUST call the EXISTING `game_core::encounter_triggers(roll, encounter_rate)` — do NOT write a second predicate. Threshold = the `encounter` row's `encounter_rate` (per-mille [0,1000]) passed verbatim.

## R-D (red-team S1/S2) — `begin_encounter` carries ALL guards + builds a NON-empty wild team
`fn begin_encounter(ctx, player_identity, party_monster_ids, wild_species_id, wild_level, individuality_seed) -> Result<u64,String>` MUST, since it builds the `Battle` directly (not via `start_battle`):
1. Reject empty `party_monster_ids` (else empty `side_a.team` → `submit_attack` panics on `active_monster()`).
2. Reject duplicate party ids (double-XP guard, like `start_battle:944`).
3. Reject if `player_identity` already has an `Ongoing` battle (re-query, keyed on player_identity).
4. Build side A from owned party (≥1 conscious guard).
5. Build `side_b.team = vec![wild_battle_monster]` — **exactly ONE element** (NOT empty; `write_back_battle_results`/`flee` call `side_b.active_monster()` which panics on empty team). `active = 0`.
6. `opponent_identity = WILD_IDENTITY` (zero-byte sentinel const); `opponent_monster_ids = vec![]` (the wild is unowned — correct; M8c write-back loops side_a only, verified). Document the `side_b.team.len()==1` vs `opponent_monster_ids.len()==0` asymmetry in a comment so M8d doesn't zip them.
7. Insert `Battle` + `battle_wild`. Log ONLY `{battle_id, wild_species_id, wild_level}` — **never** the seed/IVs/nature (red-team S3#9 side-channel).

Wild `BattleMonster` build (pure-helper, unit-testable with a fixture species): `roll_individuality(individuality_seed)` → `derive_stats(&base, &EVs::zero(), &nature, Level::new(wild_level)?)` (`EVs::zero()` exists; `Level::new(wild_level)?` makes an out-of-range content level a loud `Err`, never a panic) → full-HP `BattleMonster { species_id, affinity, level: wild_level, current_hp = stats.hp, max_hp = stats.hp, stats, known_skill_ids = species.learnable ∩ skill_row }`. IVs/nature consumed only into derive_stats + (the seed into) the private row.

## R-E (red-team S2#4) — RNG: one draw per character, no hit/miss asymmetry
In `movement_tick`, per character that `stepped_onto_grass`: draw **exactly ONE** `let seed: u32 = ctx.random()`, then splitmix-derive sub-rolls `(trigger_roll, species_roll, level_roll, individuality_seed)` from it. Consumption is one draw per stepping character regardless of hit/miss → A's hit cannot shift B's roll in the same tick. Order:
1. `stepped_onto_grass`? no → skip (no draw).
2. has `player` row? no (NPC) → skip. already `Ongoing`? → skip.
3. draw the one seed; `encounter_triggers(trigger_roll, ???)` — but rate lives in the `encounter` row. **Read the encounter row first (cheap pk `find(zone)`), then `encounter_triggers(trigger_roll, row.encounter_rate)`**. Missing row (partial-sync) → no-op. rate 0 → never. (The "cheap roll first" intent = do the modulo gate before the *species* table-scan/`roll_encounter`, not before the single pk lookup of the rate.)
4. on hit: `roll_encounter(table, species_roll, player_level)` → `None` (no eligible species) → no-op. `player_level` = the lead (lowest party_slot) owned monster's level; no party → no-op (and empty-party guard in begin_encounter is the backstop).
5. pick `wild_level` in `[entry.min_level, entry.max_level]` via `level_roll`; `begin_encounter(...)`.

Every failure mode in steps 3–5 is a **no-op, never a panic**.

## R-F (m1) — `start_wild_battle` manual entrypoint = faithful double, NO client seed
`#[reducer] start_wild_battle(ctx, zone_id: u32) -> Result<(),String>`: validate sender joined + has a party + not already `Ongoing`; draw `ctx.random()` (NO client-supplied seed → no IV-grind cheat surface); roll species/level from the zone's PRIVATE `encounter` table exactly like the grass path; call `begin_encounter`. It is a faithful test double of the grass path (the e2e entry, since `movement_tick` is scheduler-only) AND the spec's "manual start_battle". Doc-comment it as a dev/test entry to gate or remove at M9+.

## R-G (red-team S1#2) — partial-sync win-path residual
`begin_encounter` validates the wild's `species_row` exists at creation (R-D); `species_row` is never deleted by `sync_content` (insert/update only), so the later win-path lookup (`write_back_battle_results:1294`) cannot miss it for a battle created after sync. Accepted residual (no new handling); note in ADR-0045.

## R-H (red-team S4 #10/#11/#12) — privacy eval clone hardening (`wild-individuality-privacy.eval.mjs`)
Clone `encounter-privacy.eval.mjs` (reuse `stripComments`/`parseTables` VERBATIM — name-agnostic; **no `new RegExp`**, only literal regex + `String.indexOf`). The clone MUST:
1. Check exact `t.name === 'battle_wild'` private (rename from `'encounter'`).
2. **Assert the `battle_wild` table EXISTS** (fail loud on absence — do NOT treat "not found" as pass; avoids vacuous-pass if the rename/table is missing).
3. Projection check on `battle_wild`-prefix (NOT `battle`-prefix — `battle` is legitimately public; a `battle`-prefix check would wrongly flag it).
4. **NEW tooth — no leaked columns on public `battle`:** parse the `battle` table's fields and FLAG any field name containing `wild_`, `iv_`, or `nature` (closes the gap that `battle-schema-snapshot` is subset-only and would let the spec's literal "store on battle row" ship green + leak).
5. Glob `client/src/module_bindings/battle_wild*_table.ts` AND a camelCase variant for a leaked accessor.
6. Keep green-path + comment-stripping teeth.

## R-J — Pull the trigger's core decision into a PURE game-core fn (maximize testable surface)
The evals are static/pure-logic (real e2e is Playwright `golden.spec.ts`, a separate remote job not in `just ci`). So the EARS trigger criteria (weighted, level-ranged, deterministic, cheap-roll-first, rate-0, single-seed RNG) must be encoded in **pure game-core code** to be gated by `just ci`. Add to `game-core/src/taming/`:
```rust
pub struct WildSpawn { pub species_id: u32, pub level: Level, pub individuality_seed: u32 }
/// Pure, total, deterministic. Splits ONE seed into sub-rolls (no hit/miss RNG asymmetry),
/// gates on encounter_rate (cheap-roll-first), then weighted+level-ranged species pick + level pick.
pub fn resolve_encounter(table: &EncounterTable, seed: u32, player_level: Level) -> Option<WildSpawn>
```
Behavior: splitmix32(seed) → `(trigger_roll, species_roll, level_roll, individuality_seed)`; if `!encounter_triggers(trigger_roll, table.encounter_rate)` → `None` (rate-0 ⇒ always None); else `species_id = roll_encounter(table, species_roll, player_level)?` (reuses the SSOT weighting; `None` if no eligible entry); find that entry by `species_id` (unique per zone, ADR-0044 B1) for its `[min_level, max_level]`; pick `level` via `level_roll`; return `Some(WildSpawn{ species_id, level, individuality_seed })`. This is the SINGLE place the seed is split (red-team S2#4 fix) and is fully property-testable. The server tick branch becomes thin glue: `if stepped_onto_grass(prev,next,&map) && has_player_row && !already_ongoing { let seed = ctx.random(); if let Some(w) = resolve_encounter(&row, seed, player_level) { begin_encounter(..., w.species_id, w.level.as_u8(), w.individuality_seed)? } }`. Partial-sync (no `encounter` row for the zone) is handled in the shell: `find(zone)` → `None` ⇒ no `resolve_encounter` call ⇒ no-op. This is NOT a second `encounter_triggers` (it COMPOSES the existing ones) — it pulls the genuinely-new seed-split + level-pick + compose into the testable core.

## R-I (n1) — exhaustive match + ZONE_0 art
Adding `TallGrass` forces compile errors at BOTH `from_char` and `is_walkable` (intended). Add `~` only to interior `.` tiles NOT asserted by `world.rs` tests — avoid `(1,1)` spawn, `(2,1)`, `(3,3)`, `(4,3)`, `(1,0)`. Run `cargo test -p game-core` immediately after the tile-layer slice.
