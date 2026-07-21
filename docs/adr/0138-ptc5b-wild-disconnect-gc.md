# 0138 — ptc5b wild-battle disconnect resolution: auto-flee + GC the `battle`/`battle_wild` rows to unblock returning-player re-entry

**Status:** Accepted
**Date:** 2026-07-21
**Slice:** ptc5b (M-playtest-c.5 pre-gate residuals — wild-battle disconnect GC, EARS ptc5b-1..3)
**Supersedes:** —
**Amends:** —
**Subsystems:** battle, schema-persistence, security-authz
**Decision:** On disconnect, auto-flee the caller's Ongoing WILD battle via the flee write-back SSOT, then delete its `battle` + `battle_wild` rows to unblock returning-player re-entry; no reaper, no new tables.

## Context

`on_disconnect` (lib.rs:183) resolves a disconnecting player's transient state so a reconnect starts clean: it cancels trades (`trading::cancel_trades_on_disconnect`, ADR-0106 TR-18), forfeits ongoing **PvP** battles (`pvp::forfeit_on_disconnect`, ADR-0109 D8), cancels pending challenges (ADR-0109 D9), and deletes the `player_conversation` row (RT-ADV-01) — all before the player/character rows are deleted so identity lookups still resolve.

But the **wild/PvE battle row class has no disconnect resolution and no reaper.** `forfeit_on_disconnect` filters `outcome == Ongoing && opponent_identity != WILD_IDENTITY` (pvp.rs:576,588) — it *deliberately* excludes wild battles (a wild opponent is the `WILD_IDENTITY` sentinel, not a real player to award a forfeit win to). And unlike every other ephemeral terminal-deleted table (trade TTL, challenge TTL, pvp-deadline, playtest cap), wild `battle` rows have no scheduled reaper: `begin_encounter` (battle.rs:303) inserts a `battle` (`opponent_identity = WILD_IDENTITY`) plus a 1:1 private `battle_wild` sidecar, and nothing else ever schedules their cleanup.

Consequences of a mid-wild-battle disconnect:
1. **Persistent player-facing soft-lock.** The Ongoing `battle` row survives. On reconnect, `is_in_ongoing_battle` (guards.rs:264 → `is_in_ongoing_battle_either_role`:248) counts *any* `Ongoing` row in the player arm with no WILD exclusion (guards.rs:254), so `begin_encounter` (battle.rs:328) and `start_battle` (battle.rs:111) both reject a fresh battle — the returning player is locked out until they manually resume and flee/lose the stale battle. In a solo playtest where network drops are common, this is a first-session blocker.
2. **A slow row leak.** The `battle` + private `battle_wild` rows persist indefinitely.

This is one of the two verified MEDIUM residuals from the eleventh review (@ `0421f2c`); it is directly playtest-facing.

## Decision

Add a disconnect-driven resolution for the caller's Ongoing WILD battle, wired into `on_disconnect` alongside the existing PvP forfeit. The resolution lives in **battle.rs** (which owns battle write-back SSOT), not pvp.rs (which owns the PvP terminal funnel) — keeping the two disconnect battle-classes loosely coupled, each in its module.

```rust
// battle.rs — SSOT row-predicate (D1)
pub(crate) fn is_ongoing_wild_battle(b: &Battle, player: Identity) -> bool {
    b.player_identity == player
        && b.opponent_identity == WILD_IDENTITY
        && b.state.outcome == BattleOutcome::Ongoing
}

// battle.rs — disconnect resolution (D2..D4)
pub(crate) fn resolve_wild_battle_on_disconnect(ctx: &ReducerContext, disconnected: Identity) {
    // collect-then-mutate (mirrors forfeit_on_disconnect)
    let ids: Vec<u64> = ctx.db.battle().player_identity().filter(disconnected)
        .filter(|b| is_ongoing_wild_battle(b, disconnected))
        .map(|b| b.battle_id).collect();
    for id in ids {
        let Some(mut battle) = ctx.db.battle().battle_id().find(id) else { continue };
        if !is_ongoing_wild_battle(&battle, disconnected) { continue }   // re-check
        battle.state.outcome = BattleOutcome::Fled;                       // auto-flee (D3)
        if let Err(e) = write_back_battle_results(ctx, &battle) {         // flee SSOT write-back
            log::error!(/* wild_disconnect_writeback_err */);            // log-and-continue (D4)
        }
        ctx.db.battle_wild().battle_id().delete(id);                      // belt (D4)
        ctx.db.battle().battle_id().delete(id);                          // the new behavior (D2)
    }
}
```

`on_disconnect` gains one line after `pvp::forfeit_on_disconnect(ctx, me)` (both before player-row deletion). The two are disjoint battle classes (`opponent != WILD` vs `== WILD`) — no double-handling.

### D1 — one SSOT row-predicate, not a duplicated classification

`is_ongoing_wild_battle(b, player)` is the single definition of "an Ongoing wild battle owned by `player`". The selector closure calls it and the proof-of-teeth assert against it directly, so the WILD/`Ongoing`/owner classification exists once. It is the *selecting* dual of `guards::is_in_ongoing_battle_either_role` (which *tests* membership, inverted, and carries the same `!= WILD_IDENTITY` refinement in its opponent arm) — we deliberately do NOT re-implement or shadow that guard (which is out of this slice's touch-set and owned by ADR-0122).

### D2 — auto-flee, and DELETE the `battle` row (not mark-`Fled` like manual `flee`)

The disconnect terminal is **auto-flee**: `outcome = Fled` (non-decisive, no XP — the XP block at battle.rs:1041 is gated on `SideAWins`, and wild battles have no rating). Auto-flee, not auto-loss, because an involuntary network drop should not record a decisive loss; for a wild battle the two differ only in XP/rating (both nil here) and in flavor, so auto-flee is the least-punitive, most defensible choice.

Unlike the manual `flee` reducer — which sets `Fled`, writes back, then `update()`s the row so the client sees the M8.7e keep-latest-per-player outcome frame — the disconnect path **deletes** the row. Rationale: a disconnected client has no subscription to observe a terminal frame, so the outcome-frame contract has no consumer; leaving a `Fled` row would (a) be swept anyway by the *next* battle's terminal-GC (battle.rs:1009), (b) risk a stale "you fled" battle-result overlay flashing on reconnect, and (c) leak until that next battle. Deleting is leak-free and reconnect-clean. Critically, we therefore do **NOT** call `ctx.db.battle().battle_id().update(battle)` (the manual-flee tail) — doing so would resurrect the row we intend to delete.

### D3 — persist damaged HP via the flee write-back SSOT; do NOT restore pre-battle HP

The resolution reuses `write_back_battle_results` verbatim — the exact path `flee` uses. `write_back_hp` (marshal.rs:368) sets the live `monster.current_hp = bm.current_hp.min(stat_hp)`, i.e. it **persists the damaged battle HP** (live rows are untouched *during* a wild battle — `begin_encounter` only snapshots them, so the live row still holds pre-battle HP until write-back). This is binding per ptc5b-1 ("SAME write-back semantics as the existing flee path").

**Rejected alternative — restore pre-battle HP** (i.e. delete both rows *without* calling write-back, leaving the live rows at their untouched pre-battle HP). The spec's decision-hook phrasing "auto-flee: restores pre-battle HP" describes this, but it is rejected: a full HP restore would make **disconnect strictly dominant over flee** (both exit the battle, but disconnect additionally heals for free) — a live "disconnect-to-heal" exploit that lets a player dodge HP loss and the heal-currency sink by rage-quitting. Persisting damage keeps disconnect ≈ flee (no advantage), upholds reject-not-clamp / no-free-advantage, and reuses the SSOT write-back so there is no bespoke HP path to get wrong.

### D4 — idempotent, caller-scoped, robust to a write-back `Err`

- **Idempotent + caller-scoped (ptc5b-2):** the selector filters `player_identity == disconnected`; a no-op when the caller has no wild battle; the three deletes are no-ops on already-deleted rows. It never touches another player's rows — the opponent-side GC inside `write_back_battle_results` (battle.rs:1024) is already skipped for `WILD_IDENTITY`.
- **Belt-and-suspenders `battle_wild` delete:** `write_back_battle_results` deletes `battle_wild` at its line 999 — but only if it reaches that far. It can return `Err` earlier (team-coupling mismatch battle.rs:988, or ownership-changed-mid-battle battle.rs:962), which would otherwise **orphan** the private `battle_wild` sidecar. So the explicit `battle_wild().delete(id)` after the (logged, non-propagated) write-back is load-bearing, not redundant. We log-and-continue rather than propagate because leaving an Ongoing/errored wild row would re-create the soft-lock — the row must not survive regardless.
- **Collect-then-mutate:** battle_ids are collected into a `Vec` before any delete/write, per the SpacetimeDB discipline (`forfeit_on_disconnect` at pvp.rs:566 is the mirror).

## Consequences

- A mid-wild-battle disconnect now leaves **no** `battle`/`battle_wild` row and **no** soft-lock; a reconnecting player can immediately start a new encounter. HP reflects the battle as it stood at drop (same as a manual flee).
- No new table, reducer, schema column, or scheduled reaper — the fix is disconnect-driven (event), not interval-driven, so it needs no `*_schedule` row (unlike the trade/challenge/pvp-deadline/playtest reapers). Additive, determinism-safe, RLS-neutral.
- The disconnect-resolution matrix is now complete: **PvP** → forfeit (ADR-0109 D8), **wild/PvE** → auto-flee-GC (this ADR), **trade/challenge/conversation** → cancel/delete.

## Alternatives considered

- **A scheduled wild-battle reaper** (mirroring the trade/challenge TTL reapers): rejected as over-engineered (YAGNI) — a disconnect is a precise, observable event, so an interval sweep would add a schedule table + reducer for no benefit over resolving inline in `on_disconnect`.
- **Extending `forfeit_on_disconnect` to include WILD**: rejected — it would couple pvp.rs's PvP terminal funnel (`settle_pvp_battle`, rating, side-B write-back) to wild battles, which have none of that; the wild path is a flee, not a forfeit. Loose coupling keeps each battle class in its owning module.
- **Restore pre-battle HP** (D3): rejected — disconnect-to-heal exploit.
- **Mark `Fled` and leave the row** (like manual flee) (D2): rejected — stale-overlay-on-reconnect + leak, with no client to consume the frame.

## Proof-of-teeth (all in-process; the harness has no in-process reducer DB — deterministic Rust unit + source-scan)

1. **Pure-core selection (battle_tests.rs):** hand-built `Vec<Battle>` — the selector/`is_ongoing_wild_battle` includes the Ongoing WILD row and excludes PvP rows (`opponent != WILD`), terminal rows (`outcome != Ongoing`), and other players' rows; empty when none present (idempotency / ptc5b-2).
2. **Re-entry-flip + mutation (battle_tests.rs, the ptc5b-3 soft-lock proof):** a set containing the Ongoing WILD row makes `guards::is_in_ongoing_battle_either_role` return `true` (soft-locked); removing the selected ids flips it to `false` (re-entry accepted). Mutation: a selector that returns empty (the "removed wild-battle branch" mutant) leaves the predicate `true` → the re-entry assertion re-fails. Mirrors the blessed pattern at raising_tests.rs:960.
3. **Body source-scan (battle_tests.rs / `BATTLE_RS`):** `resolve_wild_battle_on_disconnect`'s body references `WILD_IDENTITY`, calls `write_back_battle_results`, and contains BOTH a `battle_wild(...).delete(...)` and a `battle(...).delete(...)` (needles assembled from parts + `strip_rust_comments`/`strip_rust_strings` so the test's own literals do not self-match).
4. **Wiring source-scan (pvp_tests.rs / `LIB_RS`):** `on_disconnect` calls `battle::resolve_wild_battle_on_disconnect` (co-located with the existing `on_disconnect` PvP-helper scan `ea_pvp_05`).

**Runtime e2e coverage** (real client disconnect → reconnect → re-enter, à la `ranked-forfeit.spec.ts`) is deferred to the eval/e2e-owning slice (ptc5d/evals) — `client/e2e/**` is outside this slice's touch-set, and simulating a true SDK disconnect is flaky (ADR-0085/M13.5b never-settles-on-drop). The deterministic trio above fully gates ptc5b-1..3 without flake.

## References

- Spec: `specs/monster-realm-v2/M-playtest-c.5-pregate-review-residuals.spec.md` §2 (ptc5b), §1.2.
- ADR-0109 D8 (PvP forfeit-on-disconnect), ADR-0122 (`is_in_ongoing_battle_either_role` SSOT + WILD refinement), ADR-0077 (terminal-battle GC), ADR-0013/ADR-0106 (flee write-back), ADR-0015 (private `battle_wild` sidecar).
- Code: `server-module/src/{battle,lib,pvp,guards,marshal}.rs`; `write_back_hp` clamp evidence `marshal_tests::m13_5c_write_back_hp_clamps_to_row_stat_hp`.
