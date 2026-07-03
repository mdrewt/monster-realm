# ADR-0077: Battle lifecycle GC, XP log-and-continue, canonical skill order

**Date:** 2026-07-03  
**Status:** Accepted  
**Milestone:** M12.5e (sixth-review residuals — battle lifecycle & rules)

## Context

The sixth review (2026-07-02) found four residuals in the battle subsystem:

1. **12.5e-1 (terminal battle GC):** Terminal `battle` rows are never deleted (only `battle_wild` is GC'd at `battle.rs:645`). The `battle` table is `public` and subscribed by clients as `SELECT * FROM battle` — so unchecked growth is both a storage and a subscription fan-out concern.

2. **12.5e-2 (self-battle XP provenance):** Self-battles grant XP with no check on opponent provenance — a DECISION for Drew, not an auto-scheduled implementation. **Explicitly deferred; see §Deferral below.**

3. **12.5e-3 (XP write-back unwinnable-battle bug):** `write_back_battle_results` uses `?` to propagate parse failures in the XP loop (`Level::new(bm.level)?`, `IVs::new()?`, `EVs::new()?`, loser-species-not-found). A single corrupt `monster` row makes the battle permanently unwinnable: the reducer returns `Err`, the battle row stays `Ongoing`, and every subsequent `submit_attack` re-triggers the same failure.

4. **12.5e-4 (scan-order skill IDs):** `battle_monster_from_row` (marshal.rs) builds `known_skill_ids` by iterating the `skill_row` table in DB scan order, while `wild_battle_monster` uses `species.learnable_skill_ids` canonical content order. The AI tie-break is first-seen, so owned-monster behavior depends on storage scan order.

## Decisions

### 12.5e-1: Keep-latest-terminal-per-player at write-back

**Choice:** Delete all prior terminal (non-`Ongoing`) `battle` rows for the player inside `write_back_battle_results`, immediately before or after the existing `battle_wild` GC.

**Correctness invariant (load-bearing):** At the `write_back_battle_results` call site the current battle's DB row is still `Ongoing` — all three callers (`submit_attack`, `swap_active`, `flee`) call `update(battle)` *after* `write_back_battle_results` returns. Filtering rows where `outcome != Ongoing` therefore targets only prior terminals, never the in-flight battle. After the caller's `update()`, exactly one terminal battle remains per player. This one-terminal residue preserves the client's M8.7e battle-outcome frame.

**Alternatives considered:**
- *Short-TTL scheduled reaper:* avoids coupling GC to the write-back path; but adds a schema row, a reducer, and indeterminate delay before the frame is gone — the write-back path is simpler.
- *Immediate delete on terminal write:* delete the current battle row inside `write_back_battle_results` before the caller's `update()`. Rejected: the client reads the terminal state from the row; deleting before `update()` means the client never sees the final outcome.
- *Archive to a compact private row:* adds schema complexity without adding value for a `public` table where the whole row is client-visible anyway.

**Scope note (follow-up):** The `attempt_recruit` success path calls `write_back_party_hp` (not `write_back_battle_results`) and therefore gets no GC in this slice. A prior terminal battle row persists indefinitely after a recruit-success until the player's next non-recruit terminal battle triggers `write_back_battle_results`. This is a named follow-up — not silently dropped.

**No schema change:** The `battle` table has `#[index(btree)]` on `player_identity`, which is sufficient for the per-player scan. No reaper table required.

### 12.5e-3: XP loop log-and-continue

**Choice:** Convert per-monster parse failures in the XP section to log-and-continue, mirroring `movement_tick`'s per-character philosophy.

**Fail-loud vs log-continue split:**

| Site | Before | After | Rationale |
|------|--------|-------|-----------|
| `check_team_coupling(...)` (top) | `?` | **keep `?`** | Structural invariant — a mismatch here is a code bug, not corrupt content |
| `write_back_party_hp(...)` | `?` | **keep `?`** | HP writes are authoritative; a coupling failure is a bug |
| `party_monster_ids.get(i)` | `?` | **keep `?`** | Can't fail after `check_team_coupling` — safe to keep loud |
| Loser species lookup | `?` | **log + skip XP section** | Content-corruption class; no XP can be computed without BST |
| `Level::new(bm.level)` | `?` | **log + `continue`** | Per-monster parse failure |
| `Level::new(loser_active.level)` | `?` | **log + `continue`** | Per-monster parse failure |
| `IVs::new(...)` (level-up block) | `?` | **log + skip stat recompute** | Skip only the stat-recompute sub-block; XP/level already written |
| `EVs::new(...)` (level-up block) | `?` | **log + skip stat recompute** | Same |
| `Level::new(m.level)` (level-up block) | `?` | **log + skip stat recompute** | Same |
| `load_evolutions()` (level-up block) | `?` | **log + skip stat recompute** | Same |

**Testing note:** A true behavioral proof (corrupt level → battle still resolves as SideAWins) requires a live SpacetimeDB instance; the gate is a structural scan confirming the absence of `Level::new(bm.level)?` and the presence of `log::error!` in `write_back_battle_results`.

### 12.5e-4: Canonical known_skill_ids order

**Choice:** `battle_monster_from_row` now builds `known_skill_ids` by iterating `species.learnable_skill_ids` and filtering by those present in the provided `skills` slice — identical to `wild_battle_monster` (SSOT for the wild path).

The old impl (`skills.iter().map(|s| s.id).collect()`) produces DB scan order; the new impl produces canonical content order. The AI tie-break (first-seen skill in a tie) is therefore deterministic and content-defined for both owned and wild monsters.

### 12.5e-2 DEFERRED: self-battle XP provenance

`start_battle` permits self-battles (`opponent_identity == ctx.sender`), and XP is granted on any `SideAWins` regardless of opponent provenance. This is a **GAME-DESIGN DECISION for Drew**: granting XP in self-battles is a zero-risk XP loop (self-battles take no persistent damage, `heal_party` was free/uncooldownd). Recommendation: gate XP on `opponent_identity == WILD_IDENTITY` (or future NPC/raid provenance). This forecloses "practice XP" — hence the decision.

**No XP-provenance behavior was changed in this slice.** This deferral is recorded here per the M12.5 DoD ("explicitly deferred with a note — not silently dropped").

## Consequences

- Terminal `battle` rows are bounded: at most 1 per player at any time (in the common paths through `write_back_battle_results`).
- A corrupt `monster` row can no longer permanently block a battle from resolving — the XP for that monster is skipped and logged; other monsters' XP and HP are unaffected.
- Owned-monster and wild-monster skill order now match: canonical content order, not DB scan order. AI behavior is deterministic over content.
- `attempt_recruit` success-path GC gap remains as a named follow-up.

## Testing

- **12.5e-1:** `battle_tests::write_back_battle_results_gcs_old_terminal_battles` (source-guard: `ctx.db.battle().battle_id().delete(` present in body); `evals/battle-terminal-gc.eval.mjs` (proof-of-teeth: fn-without-GC fixture fails).
- **12.5e-3:** `battle_tests::write_back_battle_results_xp_loop_does_not_propagate_level_parse_err` (source-guard: `Level::new(bm.level)?` absent); `battle_tests::write_back_battle_results_xp_loop_uses_log_error_for_continue` (source-guard: `log::error!` present).
- **12.5e-4:** `marshal_tests::owned_battle_monster_known_skills_respect_canonical_order` (pure unit test: skills in reverse scan order → canonical output order).
