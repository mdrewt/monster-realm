# 0168 — Real server battle movement lock: drain-time freeze in `movement_tick`, intake rejects in the move reducers

**Status:** Accepted
**Date:** 2026-07-31
**Slice:** 11r-c (M-postgate-eleventh-review-residuals §2; EARS E1–E3)
**Supersedes:** —
**Amends:** ADR-0166
**Subsystems:** movement-netcode, security-authz, battle
**Decision:** `movement_tick` gains a drain-time battle lock (skip the drain, queue intact, via the ADR-0122 SSOT) and `enqueue_move`/`set_move` reject intake mid-battle; `clear_queue` stays deliberately unguarded.

**Scope, stated up front:** this slice changes only `server-module/src/movement.rs` plus its
gating tests and the `evals/zone-warp-server-runtime.eval.mjs` gate (ADR-0166 R3). No schema,
no `game-core` rule, no client, no sim-harness edit. `guards.rs` is deliberately unchanged (D4).

## Context

The sim-harness models a drain-time battle lock (`sim-harness/src/world.rs:101-104`) whose
comment claims it mirrors "the server's battle-lock check in `movement_tick`" — **that check
did not exist** (ADR-0166 R10). The real drain had no battle read (only the warp branch queries
battles, since 11r-a), and `enqueue_move`/`set_move`/`clear_queue` passed `authorize_move` with
no battle guard. A modified client could therefore walk mid-battle — walking out of a wild
encounter's tile, repositioning during ranked PvP, or lining up a warp for the instant the
battle ends — with only honest-client overlay suppression (`main.ts:1197-1201`) preventing it.
The `battle_lock_convergence` criterion in `evals/netcode-convergence.eval.mjs:39` certified the
harness's fiction as if it were server behavior.

## D1 — Drain-time battle lock in `movement_tick`

Inside the per-character loop, **after** the empty-queue early-continue and **before**
`move_queue.remove(0)`:

```rust
let battle_locked = ctx
    .db
    .player()
    .entity_id()
    .filter(id)
    .next()
    .map(|p| is_in_ongoing_battle(ctx, p.identity))
    .unwrap_or(false);
if battle_locked {
    if row.action != ActionState::Idle {
        row.action = ActionState::Idle;
        ctx.db.character().entity_id().update(row);
    }
    continue;
}
```

- **Skip drain, queue intact** — matching the harness semantics exactly (`world.rs:101-104`):
  the queue is untouched, `action` is normalised to `Idle` write-on-change (an unconditional
  update would churn the row ~5×/s per battling player and broadcast a no-op to every
  subscriber), and the lock self-releases the tick after the battle's outcome leaves `Ongoing`
  because the SSOT predicate is re-evaluated fresh every tick.
- **Placement after the empty-queue arm**: idle characters — the overwhelming majority every
  tick — pay zero extra probes. Only characters with a queued move pay (1 `player` + ≤2
  `battle` btree probes). Honest cost framing: because the guard prevents the queue from ever
  draining while locked, a character that entered battle with a non-empty queue pays those
  probes **every tick for the battle's duration**, not merely for the ≤2 ticks a drain would
  take. Bounded by concurrent battling movers; accepted.
- **The argument is the character's own `p.identity`.** `movement_tick` is scheduler-only, so
  `ctx.sender` inside it is the module identity; asking about it would make the guard always
  false (strictly worse than the bug — see ADR-0166 D4's identical analysis for the warp guard).
- **`unwrap_or(false)` is a FACT, not the warp guard's POLICY.** The warp guard's
  `unwrap_or(true)` fifteen lines below encodes an ADR-0070 home-zone *policy* ("no player row
  ⇒ an NPC ⇒ skip the warp"). The drain guard's `false` states a *fact*: a character with no
  `player` row is not a player and can never appear in a `battle` row, so it is not
  battle-locked. Failure-direction check: `true` would freeze a (hypothetically) queued NPC
  move forever; `false` degrades to pre-slice behavior. Do not "unify" the two defaults.
- **SSOT delegation is forced, not just preferred**: `movement_tests.rs` layer 1c pins the
  `battle()` table accessor to exactly one occurrence in `movement.rs` (the grass pre-check).
  Any inline battle scan or per-tick cache would turn a prior slice's gating test red.

## D2 — Intake rejects: `enqueue_move` and `set_move`

Both reducers *add* movement intent; both gain, as their **first statement** (before
`authorize_move`):

```rust
if is_in_ongoing_battle(ctx, ctx.sender) {
    let e = "cannot move during an ongoing battle".to_string();
    log_reject("enqueue_move", ctx.sender, &e);
    return Err(e);
}
```

Reject-not-clamp at the trust boundary; message follows the `raising.rs` idiom ("cannot care
during an ongoing battle"). Here `ctx.sender` is correct — these are player-called reducers.
Siting before `authorize_move` is observationally identical to after (an `Err` rolls the whole
transaction back, including the accept-time ack — `guards.rs:87-94`) but avoids doing the
player/character lookups and the ack write on a doomed call. `set_move` has no production
caller today (spec §5), but it is a public reducer and the client is hostile — guarded.

## D3 — `clear_queue` is deliberately NOT guarded (the anti-decision)

This is the load-bearing paragraph; without it the next consistency-minded pass adds the
"missing" symmetric guard and ships a bug (the exact failure mode ADR-0166 D2 documented for
"or flee"/"or forfeit"):

1. `clear_queue` is pure cancellation. It **cannot cause movement** and enables no attack.
2. Rejecting it would force the stale pre-battle queue to survive until battle end — turning
   the post-battle stale drain (a residual D1 merely tolerates, see Consequences) into a
   *guaranteed* behavior, strictly worse.
3. It would deny an honest key-release cancel while the battle overlay is opening.

Consequence: the battle guard must **not** live inside `authorize_move` (it would cover all
three reducers, including `clear_queue`, coupling a decision that must differ per reducer).
The gating tests pin `clear_queue`'s entire body and `authorize_move`'s battle-guard-freedom so
neither a direct guard nor a differently-named wrapper can reintroduce it silently.

## D4 — No helper, no shared computation

- A `guards.rs` context-taking helper for the 4-line intake block was rejected: two call
  sites, not unit-testable as a pure predicate, and a parameterised-default drain/warp helper
  is precisely the wrong-argument evasion class ADR-0166 D2 killed. `raising.rs` already
  carries three inline copies of the same idiom.
- Hoisting one shared guard computation for drain + warp was rejected: `movement_tests.rs`
  layer 1b requires `.unwrap_or(true);if!skip_warp{` as one contiguous expression, and the
  two guards answer different questions with different defaults (D1).

## D5 — E1 delivery honesty, and R10's phrasing is superseded

- **ADR-0166 R10's literal suggested test** ("a battle-locked character stepping onto a warp
  tile ends up *moved but not warped*") described the **pre-fix status quo**, not the target.
  Under D1 that state is unreachable by construction — a locked character never reaches
  `apply_move`, so it is *frozen*, per spec E1 ("stays at its pre-lock tile across ticks"),
  which is the authority and the strictly stronger guarantee. Do not "complete" R10's literal
  test later; this ADR supersedes its phrasing.
- **There is still no reducer-executing test harness** (ADR-0156 P7). E1 is therefore
  delivered as: (a) the hardened source-pinned guard in `movement_tests.rs` (full-block
  contiguous needles — reachability by construction, not presence), (b) the lock *semantics*
  proven behaviorally by the sim-harness's existing tests
  (`world.rs` `battle_locked_character_does_not_advance`, BL-2, BL-3) in the same `just ci`
  invocation, and (c) the eval-layer tie (D6). Calling (a) an "integration test" would be
  overclaiming; this is the strongest gate the crate's test infrastructure admits.

## D6 — Eval-layer changes

- **W3 de-vacuification (ADR-0166 R3):** `checkWarpBattleGuard`'s needle was
  `BattleOutcome::Ongoing`-after-`warp_at(`, which the grass pre-check satisfies even with the
  warp guard deleted (verified empirically in 11r-a). Needle → `is_in_ongoing_battle(`; the
  GOOD fixture is updated to the real post-11r-a shape and a new BAD fixture (the retired
  inline single-role filter) proves the change bites. **Honest limit: W3 covers the WARP guard
  only** — the drain guard sits before `warp_at(` and is structurally invisible to W3's
  after-`warp_at(` count. That is what keeps W3's teeth real (deleting the warp guard while
  keeping the drain guard still trips it).
- **New W6:** in `movement_tick`'s body, the first `is_in_ongoing_battle(` must precede
  `move_queue.remove(` — the drain lock's existence at the eval layer, with its own BAD/GOOD
  teeth. Plus a definition-uniqueness guard (`movement_tick` defined exactly once across
  server sources, `battle-reducer-security` C3 precedent) so a decoy `pub fn movement_tick(`
  planted earlier in the concatenated source blob cannot hijack extraction for W1/W2/W3/W6.
- **`netcode-convergence.eval.mjs` is unchanged.** Its `battle_lock_convergence` certification
  simply *becomes truthful*: the harness comment at `world.rs:87-89` now describes a check the
  server really has. Honest limit: nothing mechanically ties the harness model to the server
  rule except W6 + the Rust gating tests; the convergence eval certifies the harness.

## Consequences

- **Client prediction (ADR-0013) — no regression, traced:** moves accepted pre-battle sit
  undrained; the predictor rebuilds predicted = server tile + queue depth identically on every
  authoritative batch (stable, no re-issue — the divergence emitter is double-gated on overlay
  visibility and `outstandingSteps`). Post-battle-row sends are rejected and silently repaired
  (`dropRejected` → `reconcileFromStore`, M2 §3). Residual (client out of touches, masked by
  the battle overlay): while locked, the predictor's wall-clock catch-up bursts the stale queue
  locally, so the predicted tile sits up to 2 tiles ahead of the server's frozen tile until
  battle end.
- **Post-battle stale drain:** a queue filled just before battle start (≤ MOVE_QUEUE_CAP = 2)
  drains after the battle ends, converging toward the position the client already predicted; a
  remote observer sees a 1–2 tile walk. Residual, accepted; an honest client can cancel it
  with `clear_queue` (which D3 keeps possible).
- **The grass-encounter `already`-in-battle pre-check (`movement.rs:253-258`) becomes
  redundant-in-practice** (an in-battle player never drains a move) but is **retained**:
  defense-in-depth, load-bearing for `movement_tests.rs` layer 1c's `battle()` count, and its
  single-role bug remains ADR-0166 residual R4 (still open, deliberately untouched here).
- **Sim-harness intake delta (documented, not fixed):** the harness `enqueue` mirror accepts
  intent while `battle_locked` (it has no battle tables); the real server now rejects at
  intake. The drain-time lock — the authoritative freeze — is in exact parity; the intake
  reject is server-side defense-in-depth. `sim-harness/` is out of this slice's touches.

## Residuals

- ADR-0166 R4 (grass pre-check single-role) — open, unchanged.
- ADR-0156 P7 (no reducer-executing harness) — open; still the largest standing gap in this
  subsystem's gate.
- Predictor lock-window divergence + post-battle stale drain (above) — client-side polish if
  playtest ever surfaces it.
