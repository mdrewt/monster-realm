# 0136 — ptc5a care/train both-role ongoing-battle guard: close the bounded mid-battle HP-laundering path (amends ADR-0122 §D7)

**Status:** Accepted
**Date:** 2026-07-20
**Slice:** ptc5a (M-playtest-c.5 pre-gate residuals — raising battle-guard gap, EARS ptc5a-1..3)
**Supersedes:** —
**Amends:** ADR-0122 §D7 (the care/train follow-up: they are now guarded, and the "no HP-laundering vector" claim held only after this closure)
**Subsystems:** battle, security-authz
**Decision:** Add the SSOT both-role `is_in_ongoing_battle(ctx, ctx.sender)` guard (as `heal_party` uses) to `care`/`train`, so a mid-battle live-EV bump can no longer inflate the level-up heal; no new predicate or schema change.

## Context

ADR-0122 hoisted the both-role ongoing-battle guard into `guards.rs` (pure core `is_in_ongoing_battle_either_role` + ctx wrapper `is_in_ongoing_battle`) and propagated it to the four PvE battle reducers plus `evolve`/`fuse`. Its §D7 recorded `care`/`train` as an *accepted follow-up*, asserting there was **no HP-laundering vector** because `write_back_battle_results` "writes the snapshot's `current_hp`, never recomputed from the live `stat_hp`; mutation testing confirmed snapshot isolation."

That claim is an overstatement. The level-up branch of `write_back_battle_results` re-derives max-HP from the **live** `monster` row's EVs — `derive_stats(&base, &ivs, &evs, …)` (battle.rs:1170) — and folds `new_max − snapshot_old_max` into `current_hp` via `game_core::level_up_healed_hp` (battle.rs:1179 = `level_up_healed_hp(m.current_hp, bm.max_hp /*snapshot old max*/, derived.hp /*live new max*/)`; formula at xp.rs:97 is `current_hp + (new_max − old_max)`, saturating). So a player who calls `train` mid-battle to raise `ev_hp` (→ higher live `stat_hp`) receives more current-HP on the next in-battle level-up than a post-battle train would grant. The magnitude is **bounded** (one level-up heal delta, not arbitrary HP injection), but the vector is real, so §D7's "no vector" is false as written.

`care` (raising.rs:68) and `train` (raising.rs:133) carried only `require_owner` + `reject_if_monster_in_trade` — no ongoing-battle guard in either role. This is the last unguarded seam of the ADR-0122 hardening wave, and it is directly relevant to the imminent solo playtest.

## Decision

Reject `care` and `train` when the caller is in an `Ongoing` battle in EITHER role, reusing the existing SSOT predicate **`guards::is_in_ongoing_battle(ctx, ctx.sender)`** — the same helper `heal_party` already calls (raising.rs:286), with the `!= WILD_IDENTITY` refinement baked into `is_in_ongoing_battle_either_role`. One line per reducer; the helper is already imported (raising.rs:20).

```rust
if is_in_ongoing_battle(ctx, ctx.sender) {
    return Err("cannot care during an ongoing battle".to_string()); // "train" for train
}
```

The check is inserted after `require_owner(...)?` (which guarantees `ctx.sender == m.owner_identity`) and before the trade-escrow guard, mirroring `evolve`'s ordering (`require_owner → battle guard → trade guard`). No DB write occurs before this reject, so reject-never-burns holds.

### D1 — reuse `is_in_ongoing_battle`, NOT `reject_if_in_battle`

`is_in_ongoing_battle` is caller/owner-scoped and carries the WILD refinement in its pure core — the correct semantics here: "the acting player may not perform raising actions while battling", exactly matching `heal_party`. `reject_if_in_battle` is monster-scoped (takes a `monster_id`) and its both-role coverage comes from the *caller* chaining the opponent index; it is used by evolve/fuse to protect a *specific* evolving/fusing monster. For care/train the invariant is about the *actor being mid-battle*, not a specific monster, so the caller-scoped predicate is the right SSOT. No new predicate, no new code path.

### D2 — `ctx.sender` vs `m.owner_identity`

After `require_owner` succeeds the two identities are equal. `ctx.sender` is passed directly — reusing the same SSOT helper `heal_party` calls, though `heal_party` spells it through an aliased local (`let me = ctx.sender; … is_in_ongoing_battle(ctx, me)`) while `care`/`train` pass `ctx.sender` inline. The guarded predicate is identical; only the token spelling differs, which the eval accounts for per-reducer (`identTok = 'ctx.sender'` for care/train vs `'me'` for heal_party).

### D3 — policy scope (blocks all care/train while battling)

Like `heal_party`, the guard blocks care/train on ANY monster while the caller is in ANY ongoing battle — not only the specific battler. This is intentional and consistent with the heal policy, and it removes any need to reason about *which* party monster will level up. A returning player soft-locked by a *stale* wild battle (leftover after a disconnect) is the separate ptc5b concern; ptc5b adds the disconnect reaper. In ptc5a the guard is simply correct.

### D4 — proof-of-teeth

The harness has no in-process reducer DB, so rejection is proven by the codebase's established two-part pattern (mirroring `care_reducer_calls_compute_evolves_to` and the eval's `hasBothRoleBattleGuard`):

1. **Wiring source-scan** (raising_tests.rs): the `care`/`train` bodies must contain `if is_in_ongoing_battle(ctx, ctx.sender)` (whitespace-collapsed needle) — deleting the guard, or degrading it to a dead-code `let _ = …` call, flips the test RED (mutation kill).
2. **Both-role predicate scenario** (raising_tests.rs): `is_in_ongoing_battle_either_role` returns true for a wild side-A row (owner in the player arm) and a PvP side-B row (owner in the opponent arm, opponent ≠ WILD), and false when there is no ongoing battle and for a WILD-sentinel opponent — the last case pinning the `!= WILD_IDENTITY` refinement.
3. **Differential** (raising_tests.rs): `level_up_healed_hp` fed a trained-EV live max-HP heals strictly more than the untrained baseline (delta > 0) — quantifying the laundering magnitude the guard closes.
4. **Eval C1** (battle-reducer-security.eval.mjs): `care`/`train` added to `BOTH_ROLE_GUARD_REDUCERS`; the real-source scan now requires the if-form guard in 6 reducer bodies.

## Consequences

- The bounded mid-battle HP-laundering path is closed; ADR-0122 §D7's "no vector" claim is corrected to "no vector *after this closure*". (§D7 should gain an `Amended-by: 0136` backlink at the supervisor's ADR-index reconciliation — this slice does not edit ADR-0122 to stay within its touch-set.)
- Additive and determinism-safe: no schema/content/import change, no new dependency; one line per reducer, reusing an already-imported SSOT helper.
- ADR next-free: 0137.
