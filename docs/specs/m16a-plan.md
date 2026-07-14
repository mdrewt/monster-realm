# m16a — M16 PvP Spine: Rule+Reducer Slice

**Status:** planning  
**Spec:** `specs/monster-realm-v2/M16-pvp.spec.md`  
**ADR:** 0109 (`docs/adr/0109-m16a-pvp-spine.md`)  
**Branch:** `feat/m16a-pvp-spine`

---

## Slice scope

This is the serial rule→reducer spine for M16 PvP. Client UI deferred to m16b; evals to m16c.

**Delivers:**
- `game-core/src/combat/pvp.rs` — pure PvP rules: `PvpAction` type, `pvp_forfeit_outcome`, `pvp_deadline_forfeit_side`
- Schema additions: `battle_challenge` (public), `battle_action` (PRIVATE), `pvp_deadline_schedule` (private, scheduled), `ChallengeStatus` enum
- `server-module/src/pvp.rs` — all PvP reducers + scheduled reaper
- `server-module/src/pvp_tests.rs` — unit/integration tests
- `lib.rs` wiring + `guards.rs` helpers
- Updated eval baseline (`evals/baselines/table-schemas.json`)

**Explicitly NOT in this slice:** client UI (m16b), PvP evals (m16c), ranked Elo/stakes (M17).

---

## Touches (path-set)

```
game-core/src/combat/pvp.rs           NEW
game-core/src/combat/mod.rs           add pvp module
game-core/src/lib.rs                  re-export PvpAction + pvp_* fns
server-module/src/schema.rs           3 new tables + enums (additive)
server-module/src/pvp.rs              NEW domain module
server-module/src/pvp_tests.rs        NEW tests
server-module/src/lib.rs              mod pvp; + forfeit_on_disconnect call
server-module/src/guards.rs           reject_if_in_pvp_battle guard
server-module/src/battle.rs           no change (start_battle ADR-0048 guard stays)
evals/baselines/table-schemas.json    update baseline (3 new tables)
docs/specs/m16a-plan.md               THIS FILE
docs/adr/0109-m16a-pvp-spine.md       ADR-0109
```

---

## EARS acceptance criteria

### Challenge flow
- WHEN `challenge_pvp(target, party)` called with valid party THEN `battle_challenge` row with status=Pending
- WHEN `accept_challenge(id, party)` called by the target THEN challenge status=Accepted/deleted, `battle` row created, `pvp_deadline_schedule` inserted
- WHEN `decline_challenge(id)` called by target THEN challenge row deleted
- WHEN `cancel_challenge(id)` called by challenger THEN challenge row deleted
- WHEN challenger disconnects THEN pending challenges from them are cancelled

### PvP battle mechanics
- WHEN both players `submit_pvp_action` for the same turn THEN `resolve_full_turn` called exactly once, `battle.state.turn_number` increments
- WHEN one player submits and the deadline fires THEN the non-submitting side forfeits
- WHEN neither player submits and deadline fires THEN side A (challenger) forfeits → `SideBWins`
- WHEN a player disconnects mid-PvP battle THEN that side forfeits, battle goes terminal
- WHEN a player calls `submit_pvp_action` twice for the same turn THEN second call rejected ("already submitted")
- WHEN battle ends (any outcome) THEN HP is written back to both parties' monsters

### Security / RLS
- WHEN `battle_action` rows exist THEN NO client subscription sees them (private table, no `public`)
- WHEN `start_battle` called with `opponent_identity != self && != WILD_IDENTITY` THEN still rejected (ADR-0048 guard preserved)
- WHEN `accept_challenge` called by non-target THEN rejected
- WHEN `challenge_pvp` called while already in a battle THEN rejected
- WHEN `challenge_pvp` called targeting self THEN rejected

---

## Functional-core / imperative-shell split

### game-core (pure rules — no I/O)

`game-core/src/combat/pvp.rs`:
```rust
pub enum PvpAction { Attack { skill_id: u32 }, Swap { team_index: u32 } }
impl PvpAction { pub fn into_turn_choice(self) -> TurnChoice }

/// SideA forfeits → SideBWins; SideB forfeits → SideAWins
pub fn pvp_forfeit_outcome(forfeited_side: SideId) -> BattleOutcome

/// Who should forfeit at deadline?
/// a_submitted=false → SideA forfeits; b_submitted=false → SideB forfeits;
/// both false → SideA forfeits (challenger-first tie-break, documented in ADR-0109)
pub fn pvp_deadline_forfeit_side(a_submitted: bool, b_submitted: bool) -> SideId
```

### server-module (imperative shell)

`server-module/src/pvp.rs`:
- Challenge CRUD reducers (challenge_pvp, accept_challenge, decline_challenge, cancel_challenge)
- Internal `start_pvp_battle` (never a public reducer — bypasses ADR-0048 guard intentionally)
- `submit_pvp_action` — writes `battle_action`; triggers resolution when both submitted
- `resolve_pvp_turn_if_ready` — reads both actions, deletes them, calls `resolve_full_turn`
- `pvp_deadline_reaper` — scheduled, forfeits timed-out battles
- `forfeit_on_disconnect` / `cancel_challenges_on_disconnect` — called from lib.rs `on_disconnect`

---

## New schema tables (additive per ADR-0006)

### `ChallengeStatus` (SpacetimeType, in game-core types or schema.rs)
```rust
Pending | Accepted | Declined | Cancelled
```

### `BattleChallenge` (PUBLIC)
Columns: `challenge_id u64 PK auto_inc`, `challenger Identity (btree index)`,
`target Identity (btree index)`, `challenger_party_ids Vec<u64>`,
`status ChallengeStatus`, `created_at_ms i64`

### `BattleAction` (PRIVATE — must-never-leak)
Columns: `action_id u64 PK auto_inc`, `battle_id u64 (btree index)`,
`player_identity Identity`, `action PvpAction (game_core type)`,
`turn_number u16`, `submitted_at_ms i64`

### `PvpDeadlineSchedule` (PRIVATE, scheduled — in pvp.rs, NOT schema.rs)
Columns: `scheduled_id u64 PK auto_inc`, `scheduled_at ScheduleAt`, `battle_id u64`

### `Battle` (EXISTING — additive change)
Add `#[index(btree)]` to `opponent_identity` for efficient `forfeit_on_disconnect` lookup.

---

## Guard ordering (reject-not-clamp pattern)

### `challenge_pvp`
1. joined (has player row)
2. target != ctx.sender (no self-challenges)
3. target is online
4. check_party_size(party_ids.len())
5. not already in an ongoing battle
6. not already has a pending challenge (either as challenger or target)
7. Each party monster: owned by caller, party-slotted, not in trade

### `accept_challenge`
1. challenge exists
2. ctx.sender == challenge.target
3. challenge.status == Pending
4. check_party_size(party_ids.len())
5. not already in an ongoing battle
6. Each party monster: owned by caller, party-slotted, not in trade

### `submit_pvp_action`
1. battle exists + ongoing
2. ctx.sender is player_identity OR opponent_identity (either participant)
3. action.turn_number check: validate skill_id / team_index is legal
4. not already submitted this turn (double-submit guard): no existing battle_action row for (battle_id, ctx.sender, turn_number)
5. Insert battle_action row
6. Check if both submitted → resolve inline

### `pvp_deadline_reaper`
1. schedule row still exists (idempotent — ignore if already resolved)
2. battle exists + still ongoing
3. Determine who has submitted this turn
4. Apply pvp_deadline_forfeit_side → forfeit the losing side
5. write_back_battle_results, update battle row
6. Delete all battle_action rows for this battle_id

---

## Cross-boundary contracts

- `PvpAction` must derive `SpacetimeType` (under `#[cfg(feature = "spacetimedb")]`) to be storable in `battle_action`
- `ChallengeStatus` must derive `SpacetimeType` for `battle_challenge`
- `PvpAction::into_turn_choice() -> TurnChoice` — conversion lives in game-core (pure)
- `start_pvp_battle` calls existing `battle_monster_from_row`, `build_ability_store`, `apply_entry_ability`, `begin_encounter`-like setup — no new contracts

---

## Anti-patterns to avoid

1. Do NOT add `public` to `battle_action` — competitively decisive leak
2. Do NOT call the `start_battle` reducer from `accept_challenge` — it still has ADR-0048 guard. Use internal `start_pvp_battle`
3. Do NOT put `PvpDeadlineSchedule` in `schema.rs` — must colocate with `pvp_deadline_reaper` reducer
4. Do NOT add new `BattleOutcome` variants — BSATN breaking change (existing rows can't decode new discriminants)
5. Do NOT implement client UI (m16b) or evals (m16c) in this slice
6. Do NOT remove `start_battle`'s ADR-0048 provenance guard — battle-reducer-security eval checks for it
7. Do NOT composite-unique-constraint on (battle_id, player_identity) — unsupported in SpacetimeDB 2.6; enforce in code

---

## Build sequence

1. `game-core/src/combat/pvp.rs` + tests → `cargo test -p game-core`
2. `server-module/src/schema.rs` additions → baseline regen
3. `server-module/src/pvp.rs` reducers → `cargo nextest run -p monster-realm-module`
4. `server-module/src/pvp_tests.rs` unit tests
5. `guards.rs` additions
6. `lib.rs` wiring
7. Full `just ci`
8. Open PR
