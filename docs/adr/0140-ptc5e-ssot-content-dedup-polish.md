# 0140 — ptc5e SSOT / content / dedup polish: CARE magnitudes + shared cooldown-ready predicate to game-core; heal-location stale-delete; isPvpBattle canonicalization; resetCharacters comment fix

**Status:** Accepted
**Date:** 2026-07-21
**Slice:** ptc5e (M-playtest-c.5 pre-gate residuals — SSOT/content/dedup polish, EARS ptc5e-1..5)
**Supersedes:** —
**Amends:** —
**Subsystems:** content, client-ui
**Decision:** Relocate CARE magnitudes to game-core; share one pure `is_cooldown_ready` predicate across care and heal; reap content-removed heal rows; dedup `isPvpBattle`; fix a stale comment — behavior-preserving SSOT polish, no schema change.

## Context

The eleventh review (M-playtest-c.5 §2.6) flagged four residual SSOT/dedup drifts that are individually harmless but each violate a project invariant the codebase otherwise upholds:

1. **CARE magnitudes lived in the shell.** `CARE_BOND_AMOUNT = 5` and `CARE_COOLDOWN_MS = 6*60*60*1000` were `pub(crate) const`s in `server-module/src/raising.rs:38,40`, while every sibling global rule/rate magnitude lives in `game-core` (`CHALLENGE_TTL_MS`/ADR-0126, `RECRUIT_BASE_RATE`, EV caps, `MAX_BALANCE`). The consuming rule `game_core::apply_care(bond, amount)` was parameterized and pinned no canonical value, so the SSOT for "how much bond a care grants" and "how long the care cooldown is" sat one layer too high (spec Decision C).
2. **`seed_heal_locations_from` (content.rs:653) was upsert-only.** Unlike the zone/type/shop/fusion re-seeds — which delete rows whose id vanished from the loaded RON (`stale_zone_def_ids`, content.rs:376 + delete loop content.rs:89-98) — a heal location removed from RON kept its `heal_location_row` forever and stayed usable. Asymmetric content lifecycle.
3. **The PvP-vs-wild classifier was duplicated.** `isPvpBattle` (client/src/ui/eventRing.ts:130) and an inline copy in `battleModel.ts:262` implemented the same `opponentMonsterIds.length>0 && opponentIdentity!==playerIdentity` heuristic — a drift risk.
4. **A stale comment lied.** `connection.ts:519-521` claimed `store.resetCharacters()` clears stale-zone characters on zone transition, but it has no non-test caller (main.ts:308 explicitly documents it is NOT called; the `currentZoneId` render filter is the real mechanism).

## Decision

### ptc5e-1 — CARE magnitudes + a single cooldown-ready predicate in game-core
- `CARE_BOND_AMOUNT: u8 = 5` and `CARE_COOLDOWN_MS: i64 = 6*60*60*1000` become `pub const`s in `game-core/src/raising/rules.rs` beside `apply_care`, re-exported through `raising/mod.rs` and `lib.rs` (the established `apply_care`/`is_challenge_stale` export chain). The shell imports them; the two `const` lines are deleted (one definition, in game-core).
- A pure `pub fn is_cooldown_ready(last_ms: i64, now_ms: i64, cooldown_ms: i64) -> bool = now_ms.saturating_sub(last_ms) >= cooldown_ms` is added to game-core, mirroring `is_challenge_stale` (combat/pvp.rs:109): saturating-sub so a future/skewed clock can only OVER-reject (never bypass), and `>=` so `elapsed == cooldown_ms` is READY (the exact dual of the shell's prior strict-`<` reject — behavior-preserving; raising_tests.rs:378-410 pin this boundary).
- **The cooldown CHECK stays in the imperative shell** (it needs `ctx.timestamp`, ADR-0058/0059). BOTH `evaluate_care` (raising.rs) and `evaluate_heal` (raising.rs:263) now delegate their cooldown gate to `is_cooldown_ready` — one predicate, two callers.

**Deviation from the spec's literal wording (recorded per "spec is SSOT; deviate → ADR"):** the spec (Decision C, ptc5e-1) named the evaluator `is_care_ready`. Plan review (reviewer MAJOR) surfaced that `evaluate_heal` already implements the *identical* `saturating_sub < cooldown` predicate — so a care-specific `is_care_ready` would either leave heal as a second copy (a NEW duplicate in a dedup slice) or force heal to call a mis-named helper. The predicate is therefore **generalized to `is_cooldown_ready`**, which (a) better mirrors the generically-named `is_challenge_stale`, (b) makes heal's delegation honest, and (c) is *more* faithful to the spec's SSOT INTENT than the care-specific name. This is a naming/scope generalization, not a behavior change; care and heal semantics are byte-identical to before.

**Child-mod visibility (red-team BLOCKER):** the re-export into the shell is scoped to ONLY `pub(crate) use game_core::{CARE_BOND_AMOUNT, CARE_COOLDOWN_MS};` (the two names the `#[path]`-attached `raising_tests.rs` child reaches via `use super::*` — it asserts `CARE_COOLDOWN_MS==21_600_000` at :792 and the boundary at :378-410). The block-level `use game_core::{...}` that already imports `EVs`/`IVs`/`focus_train`/`Bond` stays PRIVATE and is NOT widened to `pub(crate)` — doing so would re-export those names and risk an ambiguous-glob collision with raising_tests.rs:51-52's explicit `use game_core::{EVs, IVs, ...}`. `is_cooldown_ready` is imported privately (the test does not reference it directly).

### ptc5e-2 — heal-location stale-delete
- Pure `stale_heal_location_ids(existing: &[u32], loaded: &[HealLocationDef]) -> Vec<u32>` — a sorted-ascending set-difference on `location_id`, a direct analogue of `stale_zone_def_ids`.
- `seed_heal_locations_from` gathers `existing` pks into a `Vec` FIRST (`ctx.db.heal_location_row().iter().map(|r| r.location_id).collect()`), computes the stale set, then deletes each by pk — a **two-pass gather-then-delete** (red-team BLOCKER: never delete inside a live table `iter()`, which would invalidate the iterator), mirroring content.rs:89-98. The delete precedes the upsert loop. The causal "heal at a removed location rejects" end is already guaranteed by the pre-existing find→None→`Err("heal location not found")` at raising.rs:290.

### ptc5e-3 — one canonical `isPvpBattle` (spec direction, with type-decoupling preserved)
- The canonical, **structurally-typed** `isPvpBattle` is defined in `battleModel.ts` (per the spec: the classifier is a battle-model concern and battleModel is the durable core module — eventRing is playtest-scaffolding). `battleModel.ts:262`'s inline `isPvp` now calls it. `eventRing.ts` re-exports it (`export { isPvpBattle } from './battleModel'`) so its consumers (main.ts:75/1307/1340, eventRing.test.ts:22) resolve unchanged — main.ts is untouched.
- **Reviewer coupling concern, closed with a mitigation:** the reviewer noted eventRing.ts:127 documents a decoupling invariant ("structurally typed so this module stays decoupled from net/store's StoreBattle"). Keeping the canonical parameter STRUCTURAL (`{opponentMonsterIds, opponentIdentity, playerIdentity}`, never `StoreBattle`) preserves that **type-level** decoupling: eventRing re-exports a structurally-typed function and still imports no `StoreBattle` type. The residual is a module/bundle edge eventRing→battleModel (two siblings in `client/src/ui/`); accepted as the minimal in-touch-set option (a third shared module would leave the declared path-set). The eventRing.ts comment moves with the function to battleModel.ts so no comment is left lying.

### ptc5e-4 — resetCharacters() comment
- The misleading clause at connection.ts:519-521 is corrected to describe the real mechanism (the `currentZoneId` render filter), not the uncalled `resetCharacters()`. Comment-only; behavior-preserving.

## Consequences

- **Positive:** one SSOT for the care magnitudes and one cooldown-ready predicate shared by care+heal; symmetric content lifecycle for heal locations; one PvP classifier; no lying comment. All four are behavior-preserving and determinism-safe (`ctx.timestamp` remains the sole time source; no clock/RNG added to game-core).
- **Regen gates (both lenses):** deleting the two const lines shifts the `care` reducer below them, staling `docs/knowledge/reducers/care.md`'s `#L68` anchor — `just knowledge` is run and the regenerated OKF bundle committed (knowledge-bundle-conformance is drift-gated in `just ci`). Adding this ADR requires `just adr-digest` (DIGEST drift-gated).
- **Mutation homing:** the `6*60*60*1000` expression and `is_cooldown_ready` now live in game-core; game-core-local pins (`CARE_COOLDOWN_MS==21_600_000`, `CARE_BOND_AMOUNT==5`, the `is_cooldown_ready` boundary triad) are added to `game-core/src/raising/m9a_gating_tests.rs` so the nightly game-core mutation gate can kill them in the owning crate. raising_tests.rs:792 is retained (dual coverage also proves the re-export wiring).
- **touches-delta:** beyond the declared path-set this slice edits `game-core/src/raising/mod.rs`, `game-core/src/lib.rs`, `game-core/src/raising/m9a_gating_tests.rs` (the spec-mandated export chain + game-core test home) and regenerates `docs/knowledge/**` + `docs/adr/DIGEST.md`/`design-corpus.json`. No concurrent sibling (ptc5g=client render, ptc5f=docs) owns game-core.

## Alternatives considered

- **CARE consts → content (per-location data), not game-core** — rejected (spec Decision C): a single global duration is a sibling of `CHALLENGE_TTL_MS`, not per-entity data like `heal_location_row.cooldown_ms`; modeling it as content would mis-shape a global constant.
- **e-3: canonical in eventRing.ts, battleModel imports it (reviewer's inverse)** — considered. Fewer edits and keeps eventRing a zero-import leaf, but puts the canonical home of a battle concept in the ephemeral playtest-telemetry module and departs from the spec's stated direction. Chosen the spec direction with the structural-param mitigation instead (durable home + preserved type-decoupling).
- **e-1: leave `evaluate_heal` as its own predicate** — rejected: shipping a fresh duplicate in a dedup slice; delegation is the SSOT-consistent close.
