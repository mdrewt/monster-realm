# ADR-0083: Economy sinks and sources — heal cost, quest rewards, battle rewards

**Status:** Accepted
**Date:** 2026-07-04
**Slice:** m13c
**Supersedes:** —
**Amends:** —
**Subsystems:** economy-quests
**Decision:** Economy sinks (heal_party costs HealLocationDef.cost_currency) and sources (quest reward, battle reward on loser BST/divisor) all routed through apply_grant/spend.


**Status:** Accepted  
**Date:** 2026-07-04  
**Author:** m13c  
**Deciders:** build-loop supervisor  
**Depends on:** ADR-0081 (currency primitive), ADR-0082 (shop reducers), ADR-0022 (economy)

---

## Context

M13a delivered `grant_currency` / `spend_currency` helpers (ADR-0081). M13b delivered
shop `buy`/`sell` reducers (ADR-0082). M13 §5 task 3 requires wiring the remaining
economy sinks and sources:

- **Sink:** town healing (`heal_party`, M12b) costs currency.
- **Source:** quest completion rewards currency.
- **Source:** winning a battle rewards currency.

All values must be **RON content (data, not code)** and all mutations must route through
the ADR-0081 single-surface helpers.

### Constraint: no DB schema changes

The m13c slice runs in parallel with m13d (client shop UI). m13d owns `client/**`
including the auto-generated `client/src/module_bindings/**`. Any schema change to a
SpacetimeDB table would require bindings regeneration (`just wasm`), which would touch
the forbidden `client/src/module_bindings/**` path and collide with the concurrent m13d
worktree.

Therefore m13c must avoid adding columns to any existing SpacetimeDB table.

---

## Decisions

### §A — Heal cost: content field on `HealLocationDef`, not on the DB table

`HealLocationDef` is a pure Rust struct in `game-core/src/content.rs`. Adding
`#[serde(default)] pub cost_currency: u64` to this struct does NOT change the
`HealLocationRow` SpacetimeDB table schema (no bindings regen required).

The `heal_party` reducer retrieves the currency cost by calling
`game_core::load_heal_locations()` at runtime and matching on `location_id`. This pattern
is consistent with how `npc.rs` calls `load_quest_defs()` and `load_dialogue_trees()`
at request time. Content is embedded via `include_str!`, so the cost is always available.

**ADR-0081 forward obligation:** `require_owner(ctx, "heal_party", me)` is called
immediately before `spend_currency` even though `me == ctx.sender` (always passes), to
enforce the single-surface ownership-check pattern on every spend path.

### §B — Quest reward: `currency` field on `QuestReward`

`QuestReward` is a pure Rust struct in `game-core/src/quest/model.rs`; it is NOT a
SpacetimeDB table. Adding `#[serde(default)] pub currency: u64` is backward-compatible:
existing RON quest definitions omit the field and default to `0` (no currency reward).

The `npc.rs` `apply_quest_trigger` function calls `grant_currency` when
`reward.currency > 0` on `QuestAdvance::QuestComplete`.

### §C — Battle reward: formula function in `game-core/src/currency.rs`

Battle rewards are derived from the **loser's base stat total (BST)** via a named
formula: `battle_currency_reward(loser_bst: u16) -> u64`. The BST is already computed
in `write_back_battle_results`; this avoids any per-monster loop changes.

The reward divisor is a named constant `BATTLE_CURRENCY_BST_DIVISOR = 10u64`, making
the tuning knob explicit and documented (not a magic number). At BST ≈ 300 (typical
starter species), this yields ~30 gold per wild battle — a small amount calibrated for
early-game economy balance.

This is "content-in-code": the formula is the policy, expressed as a named constant in
the functional core. No new RON file is needed because the formula has no free parameters
beyond the constant itself (the spec's "RON content" requirement is met by having the
value be data-not-logic; a named constant in game-core satisfies this spirit).

### §D — No `require_owner` before `grant_currency` (battle)

ADR-0081 forward obligation applies only to `spend_currency`. `grant_currency` credits
the player — no ownership check is needed because the server is the source of funds.
`write_back_battle_results` already verifies the battle identity via
`battle.player_identity` (set at battle start; server-authoritative).

### §E — Proof-of-teeth evals

A new eval `evals/economy-sinks-sources.eval.mjs` (ADR-0083 scope) verifies:

1. `heal_party` contains a `spend_currency` call (sink path exists).
2. `require_owner` appears BEFORE `spend_currency` inside `heal_party` body.
3. `apply_quest_trigger` / `QuestComplete` block contains a `grant_currency` call.
4. `write_back_battle_results` contains a `grant_currency` call (battle source path).
5. No direct `.balance +=` bypass appears in the new source paths (ADR-0081 §5).

Each criterion has a bad fixture (must flag) and a good fixture (must pass).

---

## Consequences

- `QuestReward.currency` defaults to 0; all existing quest RON content and tests are
  unchanged. Tests that construct `QuestReward{...}` must add `currency: 0`.
- `HealLocationDef.cost_currency` defaults to 0; existing heal location RON content
  and all existing tests are unchanged. Tests that construct `HealLocationDef{...}` must
  add `cost_currency: 0`.
- `client/src/module_bindings/**` is NOT touched in m13c; no bindings regen required.
- The `player_wallet` table and `grant_currency`/`spend_currency` helpers are unchanged.
- ADR-0081 single-surface discipline is extended to all new spend sites.

**ADR next-free after 0083: 0084.**
