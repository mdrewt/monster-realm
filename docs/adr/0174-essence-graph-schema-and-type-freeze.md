# 0174 — Essence-graph schema & core-type freeze (Migration A; fusion deleted)

**Status:** Accepted
**Date:** 2026-08-03
**Slice:** EG1 (M-evolution-essence-graph — EARS EG1-1..EG1-12)
**Supersedes:** —
**Amends:** ADR-0060, ADR-0061, ADR-0062
**Subsystems:** evolution-fusion, schema-persistence
**Decision:** Land Migration A (+16 Monster / +12 MonsterPub / Species.tier / new public evolution_path table) and the game-core essence-graph type freeze, deleting fusion outright, so EG2/EG3/EG4 fan out behind one frozen contract.

## Context

Design authority: `specs/monster-realm-v2/adr/0019-evolution-fusion-model.md` **Amendment — 2026-08-02** (Drew's r2 override: fusion removed as a feature; evolution becomes a public, subscribable directed graph gated on level, per-Affinity essence, Trust, Quality Time, and Nutrition). This ADR records the *how* of the EG1 slice — the schema/type freeze — not the *why* of the redesign; read the 0019 amendment for that. The implementation-ready spec is `M-evolution-essence-graph.spec.md`; EG1 is its serial first slice.

## D1 — Migration A shape (additive-only, one-shot discipline)

Live spacetime 2.6.0 (measured, ADR-0173 D5) accepts an automatic migration ONLY as tail-appended columns each carrying an explicit `#[default(...)]`; mid-struct inserts and nested-`SpacetimeType` widening are rejected. Migration A therefore appends, in this exact order:

- `Monster` (private) +16: `essence_fire, essence_water, essence_plant, essence_electric, essence_earth, essence_wind, essence_light, essence_dark` (all `u32`, `#[default(0)]`, Affinity declaration order), `trust_favorable_count: u32`, `trust_unfavorable_count: u32`, `trust_favorable_battle_day_epoch: u32`, `quality_time_ticks_total: u32`, `quality_time_accum_ms: u32`, `quality_time_window_ms: u32` (all `#[default(0)]`), `quality_time_window_start_ms: i64`, `last_essence_train_at_ms: i64` (`#[default(0)]`).
- `MonsterPub` (public) +12: `tier: u8`, the same 8 essence columns, `trust_tier: TrustTier` (`#[default(TrustTier::Neutral)]` — with K=10 smoothing, zero history is exactly 0.5, the 5-band midpoint), `quality_time_tier: u8`, `nutrition_pct: u8`.
- `SpeciesRow` +1: `tier: u8` (`#[default(0)]`).
- New public table `evolution_path` (`EvolutionPathRow`): `path_id: u64` PK auto_inc (DB-internal only — NEVER durable identity; `edge_id: u32` is the durable, author-assigned, append-only edge identity, EG1-12), `edge_id`, `from_species: u32` `#[index(btree)]`, `to_species: u32`, `min_level: u8`, `essence: Vec<EssenceRequirementRow>`, `min_trust_tier: Option<TrustTier>`, `min_quality_time_tier: Option<u8>`, `min_nutrition_pct: Option<u8>`.
- New nested `SpacetimeType` struct `EssenceRequirementRow { affinity: Affinity, amount: u32 }` (EncounterEntryRow precedent).

**Measured during the build (new BSATN rule):** `#[default(0)]` on an `i64` column encodes the default as 4 bytes and live spacetime 2.6.0 REJECTS the publish (`data too short for i64: Expected 8, given 4`). i64 columns must use a typed literal — `#[default(0i64)]` — for the automigration to be accepted. Verified end-to-end: the pre-EG1 (v17) module was published to a scratch DB, a live monster created, then this v18 module published WITHOUT `--delete-data` — accepted; the row survived; all 28 appended columns read their defaults; stale `fusion` rows cleared.

`bond`, `evolves_to`, and the `Fusion` table struct remain in place, unused/frozen — their removal is **Migration B** (EG5-6), a separate publish; automatic migration rejects combined additive+removal.

## D2 — The A/B migration split

Column/table REMOVAL cannot ride with an additive publish. Migration B lands only after EG2/EG3/EG4 no longer read/write `bond`/`evolves_to` (verified by compiler+grep). Until then `evolves_to` is a frozen dead column: EG1 deletes `compute_evolves_to` and all its write paths (its content model — `SpeciesEvolutions` — no longer exists); `sync_content`'s re-derive pass now writes `None`.

## D3 — Fusion deletion (what goes, what stays inert)

Deleted outright in EG1: `game_core::fuse`, `fusion_eligible`, `FusionError`, `MIN_FUSION_BOND`, `MIN_FUSION_LEVEL`, `FUSION_EFFICIENCY`, `LEVEL_RETENTION_FLOOR`, `scale_u32`, `FusionRecipe`, `fusion.ron`, `load_fusion`, the server `fuse` reducer, `reject_if_not_fusable`, `find_fusion_recipe`, and the fuse test matrix. Stays inert pending Migration B: the `Fusion` table struct (schema element), its generated `fusion_table.ts` binding, and the client fusion UI (EG4-5 deletes it). Stale `fusion` rows on a live DB are cleared by the v18 `sync_content` (rows are data, not schema) so the still-live client UI does not render recipes for a removed feature. ADR-0147/0149's fusion provisions are superseded by the essence-graph redesign; formal `Superseded-by:` backlinks land with EG5-4's consolidated ADR.

## D4 — TrustTier + Bayesian smoothing (K=10, integer-only)

`TrustTier = Hostile | Wary | Neutral | Friendly | Devoted` (`Ord`, ascending; game-core, `SpacetimeType` behind the `spacetimedb` feature flag like `Affinity`). `trust_tier_of(fav, unfav)` applies `smoothed = (fav + K) / (fav + unfav + 2K)`, `K = 10` **fixed by directive** (not playtest-tunable), evaluated in integer math via u64 cross-multiplication `(fav+K)*100 >= band_pct*(fav+unfav+2K)` — no floats in game-core (ADR-0003). Band boundaries `[30, 45, 60, 80]` percent (playtest-tunable): zero history = 50% = Neutral; one favorable = 52.4% = Neutral (the anti-saturation teeth); Devoted reachable at 30 net favorable; Hostile at 14 net unfavorable.

## D4b — unmet_requirement lives in game-core (rules layer owns gate descriptions)

`unmet_requirement(instance, path) -> Option<String>` (None iff `path_satisfied`; Some names the FIRST unmet gate with its keyword and threshold) lives in `game-core/src/evolution/eligibility.rs`, not the server module. Two reasons: (1) SSOT — the EG4 client requirements panel ports the same helpers, so the gate-description logic must live once in the rules layer; (2) it makes the EG1-11 anti-drift gate sound: `server-module/src/evolution.rs`'s entire production region is source-scan-banned from referencing any gate field (`min_level`, `min_trust_tier`, `.amount`, tier helpers, …) — possible only because no legitimate gate-field reader remains there. The reducer's reject is `path_satisfied`-driven with `unmet_requirement` supplying the message.

## D5 — Index choice: btree(from_species); R1 has NO DB-level backstop (spec deviation)

Spec EG1-4 offered a composite unique index on `(from_species, to_species)` "doubling as DB-level enforcement of R1". This toolchain has no composite unique constraint (in-repo precedent: `schema.rs` inventory note, ADR-0054). EG1 ships `#[index(btree)]` on `from_species` alone; R1 (no duplicate pair) is enforced ONLY by `validate_evolution_paths` at the content gate plus `sync_content`'s duplicate-pair seed check. EG1-12's contingency stands: if R1 is ever relaxed, `evolve(monster_id, to_species)`'s wire signature must be revisited.

## D6 — Validation rules R1–R12 with an explicit R10 empty-set carve-out

R1–R12 land in `game_core::validate_evolution_paths`, wired into `sync_content` BEFORE any write, runnable against the placeholder-empty `evolution_paths/` registry (EG1-10). **R10 (universal reachability) skips when the path set is empty**: EG1-3 authors explicit `tier: 1` for species 4,5,6,9,10,22,23,30,31 while the edge set is empty until EG3 — without the carve-out, R10 is violated by construction, `sync_content` can never succeed, and a fresh-DB `init` panics for the whole EG1→EG3 window. The carve-out is proof-of-teeth-tested in the non-empty direction (an orphan tier>0 species with a non-empty set is rejected). This is a deliberate, documented scoping of R10 to "any shipped graph", not a weakening: an empty graph is the declared pre-content state.

## D7 — pub_from_monster(m, tier) and tier sourcing: 4 fresh / 9 copy-forward (spec correction)

The spec's EG1-8 prose says 3 fresh / 10 copy-forward; the verified split is **4 fresh** (`taming.rs` attempt_recruit, `movement.rs` join_game starter — both creation; `evolution.rs` evolve — target species; `content.rs` sync_content re-derive, which already holds the species row) and **9 copy-forward** (battle ×2, monster_mgmt ×2 — set_nickname/set_party_slot, no creation site exists there — pvp ×1, raising ×3, trading confirm_trade ×1, which gains its first `monster_pub` read). Copy-forward sites NEVER fabricate a default tier: a missing `monster_pub` row is fail-loud (or the site's existing missing-row convention), never `unwrap_or(0)`.

## D8 — Named one-shot freezes (accepted foreclosures)

1. `EssenceRequirementRow`'s field set is frozen at publish (nested-type widening rejected, ADR-0173 D5). Its `Vec<>` semantics are AND-only; a same-edge OR/either-of essence gate is foreclosed without a manual migration or an R1 relaxation — recorded so a future milestone doesn't assume it's a cheap add.
2. `TrustTier`'s 5-variant set is presumptively frozen by the same BSATN mechanism (enum variant append untested against live automigration — treat as rejected until measured). Quality-Time/Nutrition tiers are deliberately plain `u8`s (re-bucketable) for exactly this reason.

## D9 — EG1-forced deviations from the spec's slice boundaries (touches-delta rationale)

`just ci` must be green at merge, which pulls the following into EG1 (each attributed in the PR's touches-delta): client bindings regen + minimal compile-compat stubs (forced by the bindings-drift eval running `spacetime generate` in CI; `fuse_reducer.ts` vanishes, `evolve` gains `toSpecies`); transitional eval edits (`evolution-fusion-content-integrity` neutralized pending EG5-1's full rewrite, `evolution-reducer-security` fuse-arm dropped + 2-arg evolve, `no-idle-accrual` GROWTH_WRITERS −fuse, `battle-reducer-security` + `trade-escrow-guards` fuse entries dropped, `pt-d2-roster-wave-2` evolution checkers retired); compiler-forced files (`content_cache.rs`, `rolls.rs`, `lib.rs` re-exports, `build.rs` registry, Species-literal test fixtures, `game-core/tests/{pt_d1_roster,item_evolution_content}.rs`); `CONTENT_VERSION` 17→18 + baselines (`table-schemas.json`, `spacetime-types.json`, content-version hash). EG1-11's schema-snapshot pin is distributed: columns/PK via the table-schemas baseline, `EssenceRequirementRow` internals via the spacetime-types baseline, the btree index via the new `evolution-path-index-pin` eval.

## Consequences

- EG2/EG3/EG4 build behind this contract with **zero further schema edits**: reducers read `ItemDef.essence_affinity`/`essence_amount` via the content registry (no ItemRow columns), the client panel reads only public `evolution_path` + `MonsterPub` fields, content authoring fills `evolution_paths/*.ron` with `edge_id`-keyed entries.
- Accepted time-boxed regression: from EG1's merge until EG3 ships content, evolution is intentionally dark (every `evolve()` rejects "no such evolution"; the shipped client's Evolve button is a safe no-op; `evolves_to` hints freeze to `None` on the next sync). Fusion is removed permanently.
- Open per spec §4: the tier cap (R11 ≤ 5, PROVISIONAL). `path_id` is never durable identity (EG1-12); `edge_id` append-only enforcement (persisted baseline) is EG5-1's.
