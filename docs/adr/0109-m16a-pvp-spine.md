# ADR-0109 — PvP battle spine (m16a)

**Status:** Accepted
**Date:** 2026-07-14
**Slice:** m16a
**Supersedes:** —
**Amends:** ADR-0048 (start_battle provenance guard — PvP path bypasses via start_pvp_battle)
**Subsystems:** battle, schema-persistence, security-authz
**Decision:** New `pvp.rs` module: challenge handshake, secret-pick, both-submitted inline resolution via `resolve_full_turn`, turn-deadline reaper, forfeit-on-disconnect. `battle_action` private (must-never-leak). Three tables, two SpacetimeType enums.

---

## Context

M16 adds PvP (player-vs-player) battles to Monster Realm. The existing `resolve_full_turn` function is already symmetric — it takes two `TurnChoice` inputs and applies them simultaneously, making it directly usable for PvP without modification. M16a delivers the functional core: schema, reducers, guards, tests, and liveness. Client UI (m16b) and eval suite (m16c) are deferred.

Key constraints entering M16a:
- `start_battle` has an ADR-0048 provenance guard that rejects any `opponent_identity` that is not `self` or `WILD_IDENTITY`. PvP battles must be created by an internal helper that bypasses this guard.
- `battle_action` (submitted player picks) must be private per ADR-0015 (must-never-leak): a leaked pick is a competitively decisive exploit. Clients detect turn resolution by watching `battle.state.turn_number` increment on the public `battle` table.
- Forfeit must map to `SideAWins`/`SideBWins` — no new `BattleOutcome` variant (BSATN stability, ADR-0006).
- The M8.9b schema is additive — no existing column or PK may change.

## Decision

### D1: Three new tables

| Table | Privacy | Purpose |
|---|---|---|
| `battle_challenge` | PUBLIC | Pending PvP challenge rows visible to both challenger and target. |
| `battle_action` | PRIVATE | Per-turn secret picks. Must-never-leak. |
| `pvp_deadline_schedule` | PRIVATE | One-shot reaper schedule. Colocated with `pvp_deadline_reaper` in `pvp.rs`. |

An `#[index(btree)]` is added to the existing `Battle.opponent_identity` field to enable O(log n) lookup of battles where a disconnecting player is side B.

### D2: `battle_action` is private with no projection

No `public`, no `#[view]`, no RLS projection. The private table is invisible to all clients. This is a must-never-leak tier 1 guarantee (ADR-0015). `ChallengeStatus` and `PvpAction` derive `SpacetimeType` (baseline updated).

### D3: Challenge lifecycle

`challenge_pvp` → `accept_challenge` / `decline_challenge` / `cancel_challenge`. On `accept_challenge`, the `BattleChallenge` row is consumed immediately (deleted); accepted challenges leave no history row in M16. Terminal-row GC deferred to M17.

### D4: `start_pvp_battle` bypasses `start_battle`

The public `start_battle` reducer retains its ADR-0048 provenance guard. PvP battles are created by `pub(crate) fn start_pvp_battle` (in `pvp.rs`) which calls `ctx.db.battle().insert(...)` directly — the same pattern used by `begin_encounter` in `battle.rs`.

### D5: Challenger-first tie-break at deadline

When the reaper fires and neither side has submitted, side A (challenger) forfeits. Rationale: challengers should not be incentivized to refuse to pick first. The tie-break is encoded in `game_core::pvp_deadline_forfeit_side(a_submitted, b_submitted) -> SideId`.

### D6: Both-submitted resolution inline

After `submit_pvp_action` inserts the action row, it immediately calls `resolve_pvp_turn_if_ready` in the same SpacetimeDB transaction. If both sides have now submitted, the turn resolves, both action rows are deleted, and the deadline is re-armed for the next turn — all atomically.

### D7: Per-turn one-shot deadline reschedule

`pvp_deadline_schedule` uses `ScheduleAt::Time` (one-shot) not `ScheduleAt::Interval` (repeating). Each resolved turn re-inserts a new deadline row. The stale-schedule check (`if battle.state.turn_number != scheduled_turn { return Ok(()); }`) makes stale reaper fires safe no-ops.

### D8: Forfeit on disconnect

`forfeit_on_disconnect` is called from `on_disconnect` before player row deletion. It applies `pvp_forfeit_outcome` to any ongoing PvP battle where the disconnecting player is either side A (via `player_identity` index) or side B (via the new `opponent_identity` btree index).

### D9: Challenge cancel on disconnect

`cancel_challenges_on_disconnect` is called from `on_disconnect`. It deletes pending *outgoing* challenges from the disconnecting player as challenger. Incoming challenges (where the player is target) are left — the challenger may reconnect. This avoids punishing the challenger for the target's disconnect.

### D10: Side-B HP write-back

`write_back_battle_results` (in `battle.rs`) covers side A (challenger) HP and XP. A new `write_back_party_hp_pvp_side_b` function in `pvp.rs` writes back side B HP. PvP XP for the winning side B (i.e. when `SideBWins`) is deferred to M17.

### D11: `require_pvp_participant` guard

Added to `guards.rs`. Returns `SideId::SideA` or `SideId::SideB` so `submit_pvp_action` knows which team to validate the action against.

## Consequences

- **Game-core is pure**: `PvpAction`, `pvp_forfeit_outcome`, `pvp_deadline_forfeit_side` live in `game-core/src/combat/pvp.rs` — deterministic, I/O-free, testable without SpacetimeDB context.
- **ADR-0048 guard preserved**: `start_battle` still rejects external opponents. PvP battles go through `start_pvp_battle`.
- **BSATN stability preserved**: no new `BattleOutcome` variants in M16. `Forfeited` can be added additively in M17 if ranked Elo tracking requires distinguishing forfeits from natural wins.
- **Additive**: three new tables, one new btree index on existing `Battle.opponent_identity`. No existing column, PK, or table changed.
- **m16b deferred**: client UI for challenge/accept/submit is m16b. The TypeScript bindings are generated and committed (`battle_challenge_table.ts`, `accept_challenge_reducer.ts`, `submit_pvp_action_reducer.ts`, etc.).
- **PvP evals deferred**: battle-reducer-security, battle-pvp-guards, and pvp-action-privacy eval additions are m16c.
- **ADR next-free:** 0110
