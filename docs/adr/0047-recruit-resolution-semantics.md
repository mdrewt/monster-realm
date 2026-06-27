# 0047. Recruit resolution: reuse `SideAWins` terminal, grant at full HP with no XP, GC the `battle_wild` row

- Status: accepted
- Date: 2026-06-27

## Context and problem statement

M8d's `attempt_recruit` reducer ends a **wild** battle when the recruit roll succeeds:
it rebuilds *that exact* wild from the private `battle_wild` seed (ADR-0045), grants it as
a new owned `monster` at full HP, and closes the battle. Several non-obvious resolution
choices need recording so a future maintainer does not "fix" them into bugs.

## Considered alternatives & decisions

### 1. Terminal `BattleOutcome` — reuse `SideAWins` vs add a `Recruited` variant
`BattleOutcome` (`game-core/src/combat/types.rs`) is `{ Ongoing, SideAWins, SideBWins,
Fled }` and derives `SpacetimeType`, so it is part of the **public** `BattleState` wire
format on the public `battle` table (ADR-0042).

- **Chosen — reuse `SideAWins`.** A recruit is a player-victorious end ("the wild is
  yours, the fight is over"). `SideAWins` is the correct terminal.
- **Rejected — a new `Recruited` variant.** It is a wire-format change rippling into the
  generated bindings, the `battle-schema-snapshot` eval, and **every exhaustive `match` on
  `BattleOutcome`** across game-core and the client — disproportionate for M8d, and the
  EARS criterion only requires "end the battle".
- **Consequence / named UI gap (reviewer M6):** the client cannot distinguish a recruit
  end from a knock-out end by `outcome` alone. It distinguishes them by observing a **new
  monster appear in the box** (`monster_pub`) plus the battle terminating — acceptable for
  M8d. A first-class recruit event is deferred to the M14 event log.

### 2. XP on recruit — none; write back party HP only
`write_back_battle_results` grants loser-XP to the player's team on `SideAWins`
(`server-module/src/lib.rs`). Calling it on the recruit path would award XP for a monster
that was *captured, not defeated* — a surprising double-reward (reviewer B1, Blocker).

- **Chosen — write back **only party HP**, no XP.** The player's monsters took damage
  weakening the wild; that HP must persist, but no battle XP is granted. Mechanism: extract
  a `write_back_party_hp(ctx, battle)` helper (the existing HP loop) and call it from both
  the recruit success path **and** `write_back_battle_results` (the XP block stays in the
  latter only). The named helper makes the no-XP invariant legible and prevents a future
  edit from calling the full results path on recruit. Gated by a proof-of-teeth test: a
  recruit success leaves every party member's `xp` unchanged.

### 3. Granted monster placement — box (`PARTY_SLOT_NONE`), full HP
- **Chosen — grant to the box** (`party_slot = PARTY_SLOT_NONE = 255`), `current_hp =
  derived HP` (full). Avoids clobbering an occupied party slot; matches the spec's "adds to
  your box at full HP". Dual-write discipline: insert `monster` **and**
  `monster_pub(pub_from_monster(..))` (ADR-0040).
- The rebuild uses `build_monster(individuality_seed, &species, Level::new(wild_level))`
  (the level-parameterized generalization of `roll_starter` in `monster/rolls.rs`, sharing
  one `roll_individuality` path → SSOT; `build_monster(seed, sp, L5)` ≡ `roll_starter`).
  So the recruited monster's IVs/nature/species/level reproduce the fought wild exactly
  (proof-of-teeth).

### 4. Failure — the wild strikes back, turn forfeited
- **Chosen — call `resolve_enemy_turn(&mut state, SideId::SideB, ...)`** (the same
  "enemy acts, player does not" primitive `resolve_player_swap` uses), preceded by an
  explicit `state.turn_number += 1` — because `resolve_enemy_turn` (unlike `resolve_turn`)
  does **not** advance the counter (reviewer B2); the manual increment keeps turn history
  consistent. Bait, if used, is already consumed before the roll (so a failed recruit still
  costs bait — intended; red-team F2). Guard: only strike if the wild has a non-empty
  `known_skill_ids` (else forfeit with no strike — defends against an AI panic on a
  skill-less wild, reviewer H3). If the strike-back ends the battle, the **full**
  `write_back_battle_results` runs (a normal loss; `SideBWins` grants no player XP).

### 5. `battle_wild` lifecycle — GC on every terminal
ADR-0045 left stale `battle_wild` rows as an accepted residual (M8c did not delete them on
flee/win). M8d closes the class:

- **Chosen — delete the `battle_wild` row on every terminal outcome.** `attempt_recruit`
  deletes it whenever the battle ends (recruit success, or a strike-back that ends it);
  and `write_back_battle_results` (the shared battle-end path for `submit_attack`/`flee`/
  `swap_active`) gains an unconditional `battle_wild().battle_id().delete(battle_id)` —
  a **no-op for PvP** (no row), a cleanup for wild battles. This resolves ADR-0045
  residual (b) without a separate reaper.

- **Determinism / security:** the recruit roll is `ctx.random()` (injected RNG, never a
  client argument); the chance is `recruit_chance(wild.max_hp, wild.current_hp,
  RECRUIT_BASE_RATE, bait_bonus)` computed server-side from live battle state. The reducer
  re-reads the `battle` row fresh and the whole resolution (grant + outcome + delete) is
  one atomic SpacetimeDB transaction, closing the double-recruit window (red-team F1).
  `RECRUIT_BASE_RATE` lives in `game-core/taming/rules.rs` next to `MISSING_HP_FACTOR`
  (SSOT; reviewer L1). Per-species base rates are a tuning follow-up (spec §6 "Open").

- **References:** ADR-0045 (the seed table this consumes + residual (b) it closes),
  ADR-0042 (battle public / why a new outcome variant is costly), ADR-0040 (dual-write),
  ADR-0046 (inventory / bait consume), ADR-0015 (the residual IV-inversion channel is
  pre-existing, not introduced here).
