# 0122 — m17.5a both-role ongoing-battle guard SSOT: side-B PvP damage-laundering exploit closure

**Status:** Accepted
**Date:** 2026-07-17
**Slice:** m17.5a (M17.5 tenth-review residuals — side-B PvP exploit closure, EARS 17.5a-1..5)
**Supersedes:** —
**Amends:** ADR-0119 (subsumes + widens the unscheduled `m17-fix-sideb-guards` residual: adds evolve/fuse and the laundering-exploit analysis)
**Subsystems:** battle, security-authz
**Decision:** Hoist the both-role ongoing-battle guard into guards.rs (pure core + ctx wrapper) as the SSOT for all PvE/PvP callers; chain the opponent index in evolve/fuse; classification pinned by eval, not a BattleKind column.

## Context

m17a (ADR-0119) pinned four PvE reducers (`submit_attack`/`swap_active`/`flee`/`use_battle_item`) with
`is_ranked_pvp(&battle)` guards to prevent rating farming, but left a residual: the "one ongoing
battle per player" invariant (enforced by `reject_if_in_battle` and the three battle-start sites)
checked only `player_identity` role, not `opponent_identity`. PvP side-B is indexed under
`opponent_identity` on the `battle` row and bypassed all four guards.

**Prod-reachable exploit:** grass `begin_encounter` (wild battle) for player A, normal battle flow.
At PvP side-B (opponent, indexed as `opponent_identity`), call `start_battle` or practice
`begin_encounter` with the same party → second `Ongoing` battle row is created. Side-B:
`write_back_battle_results` snapshots the live party's current_hp at wild-battle creation; PvP
ongoing fight; lose PvP (both sides write-back); side-B party HP is now the PvP-damaged snapshot;
flee wild battle → `write_back_party_hp` restores the snapshot's current_hp (pre-PvP value, now
higher). Net: HP restoration via wild-battle snapshot + escape. Mid-PvP heal/evolve/fuse also
possible on side-B, mutating stats during the ranked encounter, violating the fight hermetic seal.

All five EARS 17.5a criteria target this vector: reject new battles, reject mid-PvP stat mutations,
static escrow guard discovery, red-team liveness proof via direct mutation killing.

## Decisions

### D1 — Hoist to guards.rs as pure-core unit-testable split

The hoisted guard is two functions:

- **Pure core** `is_in_ongoing_battle_either_role(as_player: impl Iterator<Item = impl Borrow<Battle>>, as_opponent: impl Iterator<Item = impl Borrow<Battle>>) -> bool` — takes the two already-filtered row iterators (no `ReducerContext` arg → fully unit-testable in the crate, mirroring `reject_if_in_battle`). Player arm: `any(outcome == Ongoing)`. Opponent arm: `any(outcome == Ongoing && opponent_identity != WILD_IDENTITY)` — the WILD refinement preserved verbatim from the former pvp.rs copy so a wild battle's sentinel opponent never spuriously matches while that battle's real side-A owner is still caught by the player arm.

- **Wrapper** `is_in_ongoing_battle(ctx, identity) -> bool` — delegates to the pure core with `ctx.db.battle().player_identity().filter(identity)` as the FIRST argument and `ctx.db.battle().opponent_identity().filter(identity)` as the SECOND. Arg order is semantic (the opponent arm carries the WILD refinement, the player arm does not) — pinned by eval C3's args-region order check.

Error strings are byte-stable from the pre-hoist inline checks: `"already in an ongoing battle"` at start_battle/begin_encounter/start_wild_battle and `"cannot heal during an ongoing battle"` at heal_party; evolve/fuse continue to surface `reject_if_in_battle`'s `"monster is in an ongoing battle"`.

### D2 — movement_tick integration and determinism side effect (EARS 17.5a-4)

`begin_encounter` at grass is the only entry within `movement_tick` (movement.rs:276). The hoisted
guard is checked there. A side-B player on grass will:
1. Pre-check (movement.rs:251-259) reads `player_identity` only — fast-path, **deliberately left untouched**
   (outside touches set per M8.8c precedent; not a security check, only perf fast-fail for the actor's own
   role).
2. Draw one `ctx.random()` seed unconditionally (movement.rs:272) — **accepted side effect**.
3. Call `begin_encounter` → hoisted guard rejects side-B (reads both-role `Ongoing`).

**Outcome:** side-B on grass draws one seed even if rejected — determinism-neutral (seed consumed
either way, pre-check or post-check). **WARNING for future maintainers:** do NOT "optimize" the
`ctx.random()` draw to after the guard (diverges replay if guard rejects differently downstream),
and do not widen the pre-check to side-B role-checking without reading this ADR (the pre-check is a
fast-path only; the authoritative check is post-call inside `begin_encounter`).

### D3 — start_wild_battle (dev_reducers-gated) included for SSOT uniformity

The dev-only reducer was residual from m17a (it was not touched then). Hoisting the guard here
closes SSOT: zero duplicated role logic remains in the codebase. Dev-only status (ADR-0054,
feature-gated OFF in release/publish) is unchanged; the guard applies when the reducer runs.

### D4 — Warp-guard residual (out-of-scope, recorded as follow-up)

`movement.rs:209–222` (warp entry) checks player-role-only → side-B CAN warp mid-PvP (no
battle-liveness guard). Warp-during-battle ≠ battle-creation (distinct invariant), out of scope for
the m17.5a exploit closure. Candidate follow-up.

### D5 — Classification eval strategy instead of BattleKind column (spec M17.5 §3 Decision A amended)

Rather than adding a `BattleKind` column on the `battle` table (dynamic classification), the m17.5a
eval suite uses static per-site analysis:

- **Structure:** per reducer, per file/enclosing-function/RHS-form triple, allowlist exactly **3
  battle-insert sites** (identified by matching source text anchors: file path, function name, RHS
  form like `battle { … }`). A 4th insert site or novel provenance fails loud.
- **Guard classification:** `if is_ranked_pvp(&battle)` is the SOLE needle (no bare-variable aliases
  like `let ranked = is_ranked_pvp(&battle); if ranked`); the C4 criterion ensures no hidden
  evaluation via capture.
- **Teeth:** any refactor that introduces a new battle-insertion path or aliases the guard away
  surfaces as an eval RED.

**Rationale:** a static column requires runtime writes + versioning; per-site allowlist is a
permanent living document (audit trail) pinned at the eval layer (toolchain boundary). Additive
BattleKind column deferred to the first milestone introducing a third battle kind (not in the
current spec roadmap).

### D6 — Touches-delta: pvp.rs was outside declared touch set but required for correctness

`pvp.rs` was not in the original m17.5a spec touch set (battle.rs, evolution.rs, raising.rs,
guards.rs), but the hoisted function lives in `guards.rs` and `pvp.rs` held a private copy
(`is_in_ongoing_battle_either_role`, ~20 LOC). Removing the duplicate requires editing pvp.rs to
delete the private copy and import the shared one. Flagged for supervisor audit: the edit is
mechanical (delete + import), no logic changes.

### D7 — care/train residual: accepted follow-up candidate (no HP-laundering vector)

`care` and `train` reducers have NO battle guard in either role — a mid-PvP call mutates bond/EVs/derived
stats of a live PvP participant. **Not a direct HP-laundering vector** because `BattleMonster` HP
and stats are **snapshotted at battle creation** (game-core `build_side`); `write_back_battle_results`
writes the snapshot's current_hp (never recomputed from the live `stat_hp`). **Accepted mitigation:** this
gap is recorded as a candidate follow-up with a **critical warning** — any future write-back change that
recomputes current_hp from live `monster` stats instantly weaponizes this residual. Mutation testing
confirmed the snapshot isolation (the derive-from-snapshot seam is covered).

### D8 — start_pvp_battle guard coupling: internal → sole caller guards first (accepted)

`start_pvp_battle` is an internal function (not a reducer), sole caller `accept_challenge` guards first
via `authorize_accept` (role/status checks). C4's exact-3-sites pin forces conscious review of any new
creation path; internal-only status ensures no external caller bypasses the authoritative guard.

### D9 — Combined-gate semantics: defense-in-depth across three layers

Exploit closure is holistic — no single layer suffices:

1. **Pure-core unit matrix** (executed in `guards_tests.rs`): 7 tests covering empty-player-arm opponent
   scenarios + the laundering-two-ongoing-rows full exploitation trace.
2. **C1–C4 eval-layer wiring** (`evals/battle-reducer-security.eval.mjs`): call-site scan (C1
   if-form + identity-token per reducer), structural chain-count (C2), SSOT single-definition + wrapper
   arg-order (C3), classification guard allowlist (C4).
3. **M17a precedent** (ADR-0119 D9): the pure-core + call-site + wrapper pattern is proven by the ranked
   guards (is_ranked_pvp + 4 PvE reducer checks + arg-order pinning).

## Consequences

- The side-B HP-laundering exploit is now impossible: `begin_encounter` gate rejects the second battle
  before any row is created. All five EARS 17.5a criteria are satisfied.
- Red-team execution: 5 live mutation spot-checks all bite (opponent-arm delete → 2 unit tests RED;
  wrapper arg-swap → C3 RED; WILD refinement delete → 1 unit test RED; heal_party revert → C1 RED;
  single fuse chain removal → C2 RED).
- Movement.rs:272 `ctx.random()` seed is drawn even on side-B rejection (determinism side effect
  accepted per D2).
- Warp-during-battle residual remains (D4); care/train mid-PvP mutation residual remains with snapshot
  isolation confirmed (D7).
- `pvp.rs` private copy DELETED; import added; m17.5a output touches both guards.rs (new functions)
  and pvp.rs (deletion only, no logic change).

## Residuals

- Nested dead-code evasion of D3 (documented in ADR-0121; owned by mutation testing).
- Warp mid-PvP side-B access (D4).
- care/train mid-PvP stat mutation (D7, mitigated by snapshot isolation).
- Zero-role (unconnected player) side-B read-back (not in wild-only path; covered by m17b
  leaderboard privacy gate + movement.rs pre-check asymmetry).
