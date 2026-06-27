# 0053. Swap legality as a pure-core invariant (checked `set_active`)

- Status: accepted
- Date: 2026-06-27
- Milestone: M8.6a (pure-core swap legality)

> **ADR numbering note.** The M8.6 spec (§3, §4, §6) proposes **ADR-0050** for this
> decision, but that number — and `0051`, `0052` — are **already taken**: M8.5c landed
> `0050` (nightly mutation/coverage + bindings-drift-in-ci), M8.5d landed `0051` (biome
> lint scope), M8.5f landed `0052` (bounded client prediction queue cap). The spec's own
> §6 mandates re-confirming next-free before creating; the next free number at master
> `d39b177` is **0053**, allocated here. This ADR is the SSOT for the decision; the spec's
> stale `0050` references are reconciled out-of-band (harness-repo spec corpus).

## Context and problem statement

The pure combat core (`game-core/src/combat/`) owns the rules (ADR-0003: functional core,
single source of truth). `BattleSide` holds `active: u32` — an index into `team:
Vec<BattleMonster>` — and `active_monster()` (`types.rs:47`) reads `&self.team[self.active
as usize]`, which **panics** on an out-of-bounds index.

The resolver wrote caller-supplied team indices straight into `active` with **no bounds
check and no fainted check** in three places:

- `resolve_turn` (the `TurnChoice::Swap` branch, `resolve.rs:168` & `:175`):
  `state.side_x.active = *team_index;`
- `resolve_player_swap` (`resolve.rs:322` & `:323`): `state.side_x.active = new_active;`
- `resolve_one_attack` auto-switch on faint (`resolve.rs:111` & `:112`):
  `state.side_x.active = idx;` — here `idx` comes from `next_conscious_index()`, which by
  construction (`types.rs:64-70`) returns only an in-bounds, conscious, non-active slot, so
  **this path is already safe**.

A swap to `team_index >= team.len()` therefore panic-indexes the next `active_monster()`
read (a SpacetimeDB reducer abort); a swap to a **fainted** but in-bounds slot leaves the
resolver battling a 0-HP active, breaking the "active is always conscious" invariant the
auto-switch path upholds.

**This is latent, not live.** The only production caller, the `swap_active` server reducer
(`server-module/src/lib.rs`), pre-checks owner/ongoing/**bounds**/**fainted**/**identity**
before calling `resolve_player_swap`, and `submit_attack` never sends `TurnChoice::Swap` to
`resolve_turn`. So no current code path reaches the panic. But the **invariant lives in the
shell, not the core** — an ADR-0003 SSOT inversion — and it is a panic landmine for every
future caller (M14 deeper battle, **M16 PvP**), where "remove the runtime guard in one
refactor" or "add a new caller that forgets it" is one change away. Per the M8.5
*reject-not-clamp* / *illegal-states-unrepresentable* / *fail-loud* family, the fix is to
make the legality a property the **pure core** enforces, not a convention the shell upholds.

## Decision outcome

### 1. Checked `BattleSide::set_active` — the single sanctioned mutator

Add `BattleSide::set_active(&mut self, idx: u32) -> Result<(), SwapError>` to `types.rs`.
It rejects (returns `Err`, leaves `self.active` **unchanged**) when:

- `idx as usize >= self.team.len()` → `Err(SwapError::OutOfBounds)` — this **also covers
  the empty-team case** (`len() == 0` rejects every index).
- the target is fainted (`self.team[idx as usize].is_fainted()`) →
  `Err(SwapError::Fainted)`.

On success it sets `self.active = idx` and returns `Ok(())`.

**Check order is load-bearing: bounds first, then fainted.** The fainted check indexes
`team[idx]`; if it ran first (or shared an expression with the bounds check), an
out-of-bounds index would panic *inside the very setter meant to prevent the panic*. The
order is enforced by an explicit early-return and pinned by a test (a large OOB index on a
team whose in-range slots are all fainted must return `OutOfBounds`, not panic).

`SwapError` is a closed, **game-core-internal** enum:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwapError { OutOfBounds, Fainted }
```

No `serde`, no `SpacetimeType` — it is never stored in a table nor sent on the wire (the
server pre-validates and never calls `set_active`; the resolver consumes the `Result`
internally). Not `#[non_exhaustive]`: it is a closed, complete set of swap-safety failure
modes internal to one crate, and we *want* the compiler to flag every match site if a
variant is ever added (contrast `BattleEvent`, which is `#[non_exhaustive]` precisely
because it crosses the serde boundary — that rationale does not apply here).

### 2. Reroute every raw `active =` write through `set_active`

After this slice, **zero** raw `state.side_x.active = …` assignments remain in
`resolve.rs`; all six mutation sites go through `set_active`:

- **`resolve_turn` Swap branches** — `if state.side_x.set_active(*team_index).is_ok() {
  push Switch }`. An illegal swap is a **no-op**: side X does not switch, no `Switch` event
  is emitted (the *absence* of the event is the "Rejected" signal the spec §3 permits), and
  the rest of the turn proceeds (the other side still resolves its choice).
- **`resolve_player_swap`** — `if state.side_x.set_active(new_active).is_err() { return
  events /* empty */ }`. An illegal swap **aborts the whole intent**: no mutation, no
  `Switch`, **and no enemy turn** — the player is not charged a free enemy hit for an
  invalid request.
- **Auto-switch on faint** — routed through `set_active(idx)` too. The index is
  guaranteed valid (`next_conscious_index`), so this is infallible; it is wired so the
  side-effecting call runs unconditionally and the `Result` is consumed in both build
  profiles (no `unused` under `clippy -D warnings`, and the call is **not** inside a
  `debug_assert!` body — which strips in release and would silently skip the swap).

**The `resolve_turn` (no-op-proceed) vs `resolve_player_swap` (full-abort) asymmetry is a
named decision, not an accident.** `resolve_turn` is a *simultaneous two-choice* resolver:
one side submitting an illegal swap should not void the *other* side's legal action, and
`turn_number` advancing is `resolve_turn`'s documented per-call contract (rule #5), not a
per-action reward. `resolve_player_swap` is a *single-actor* "swap then the enemy attacks
the new active" sequence: if the swap is rejected, letting the enemy still attack the
un-swapped (possibly low-HP) monster would be the exact harm the guard exists to prevent,
so it aborts. **Neither path is reachable with an illegal swap in production today** (see
Context). M16-PvP will validate swaps at its reducer boundary (server-authoritative,
reject-not-clamp — as `swap_active` already does) and choose its own turn-arbitration
semantics; the core's job here is **panic-safety**, not turn-policy. Unifying the two
resolvers (full-turn abort in `resolve_turn`) is recorded as a possible M16 refinement, not
done now (it would restructure the hot-path turn-increment for an unreachable branch).

### 3. `AlreadyActive` (swap-to-self) is **server policy, deliberately NOT a core rejection**

The server `swap_active` rejects `idx == active` ("already the active monster"). We
**do not** replicate that in `set_active`. Rationale: a swap-to-self is **neither a panic
nor a corruption** — the resulting `active` is still in-bounds and conscious, so it is not a
*legality/safety* concern, which is all `set_active` exists to guarantee. Rejecting it in
the core would (a) be **stronger than spec §3** (whose EARS mandate only OOB + fainted
rejection), (b) silently change `resolve_turn` swap-to-self from "emit a redundant `Switch`"
to "emit nothing", and (c) in `resolve_player_swap` silently swallow the enemy turn for a
same-index input — a latent M16 tempo/stall surface. Keeping `set_active`'s contract
**exactly** spec §3 (OOB + fainted) keeps the core minimal (YAGNI) and leaves swap-to-self
where it already lives: a **shell policy** the `swap_active` reducer enforces as
defense-in-depth. The reducer's identity check is unchanged and out of this slice's
touch-set.

### 4. `swap_active` keeps its checks as defense-in-depth

The server reducer's bounds/fainted/identity pre-checks are **retained** (reject-not-clamp,
ADR-0003 boundary validation). The core invariant is now *also* enforced, so the
shell no longer *carries* the safety invariant alone — but defense-in-depth at the trust
boundary stays. No `server-module` edit is part of this slice.

## Considered alternatives (key forks)

- **Full structural privatization of `active`** (private field + validating constructor +
  getter) — this is what spec §3's "settable only through a checked operation … unrepresentable,
  not merely unreached" literally asks for, and it is **deliberately PARKED**. Privatizing
  the field forces edits to **`server-module/src/lib.rs`** (4 `BattleSide { active, team }`
  literals + the `.active` read at the identity check), to **`game-core/src/monster/
  battle_redteam_tests.rs`**, and to **`combat/redteam_new_findings.rs`** (not a `*tests*`-named
  file) — **all outside this slice's declared touch-set**
  (`game-core/src/combat/{resolve.rs,types.rs}` + `combat/*tests*.rs` + docs). Per the build
  brief, an edit outside the touch-set is a hidden dependency to be re-serialized, not
  smuggled into the slice. So this slice makes the illegal state **unreachable via the
  resolver** (the only path that took caller input) and leaves full **type-level
  unrepresentability** to a follow-up slice with a wider, serialized touch-set. Spec §3's
  "unrepresentable" is therefore **partially met**: the resolver path is closed; a raw
  `side.active = x` field write remains *possible* by design this slice. A doc-comment on the
  `pub active` field names `set_active` as the sole sanctioned mutator and points here, so the
  next editor sees the constraint at the field (mechanical-enforcement-lite).
- **Replicate `AlreadyActive` in the core** — rejected (YAGNI + spec-fidelity); see §3.
- **Silent clamp** (`idx.min(team.len()-1)`) — rejected: violates reject-not-clamp; silently
  battles the wrong monster, hiding the illegal input (same fork ADR-0049 §1 rejected).
- **Change the resolver signatures to `Result<Vec<BattleEvent>, SwapError>`** — rejected: the
  resolvers are called by `server-module` (out of touch-set); changing their signature would
  cascade outside the slice. Rejection is signalled within the existing `Vec<BattleEvent>`
  return by the **absence of a `Switch` event** + no state mutation (spec §3 explicitly
  allows this).

## Proof-of-teeth (gating tests, authored by the `tester` from the EARS criteria)

The teeth must **bite if `set_active` is reverted to a raw `self.active = idx`**. Because the
field stays `pub`, the OOB and fainted modes need *different* load-bearing assertions:

- **OOB** via `resolve_player_swap`/`resolve_turn` with `team_index` past the end: asserts
  **no panic** (a reverted raw assignment panic-indexes the next `active_monster()` read) and
  `active` unchanged.
- **Fainted** via `resolve_player_swap`/`resolve_turn` targeting a 0-HP in-bounds slot: a
  reverted raw assignment **does not panic** here (the index is valid), so "no panic" alone is
  vacuous. The load-bearing assertions are **`state.side_x.active == pre_active`** (unchanged)
  **AND no `Switch` event for that side** **AND `!active_monster().is_fainted()`**. A raw
  assignment would move `active` onto the fainted slot and fail all three.
- **`resolve_player_swap` rejection runs no enemy turn**: an illegal swap yields an **empty**
  event vector (no `Damage`) and an unchanged opponent HP.
- **Unit** `set_active`: `Ok` on a valid (in-bounds, conscious) target with `active` updated;
  `Err(OutOfBounds)` on `idx == len`, `idx == u32::MAX`, and empty team; `Err(Fainted)` on a
  0-HP target; **order-pinning** — a large OOB index on an all-fainted team returns
  `OutOfBounds` (proves bounds-before-fainted, no panic in the setter).

**Honest scope of the teeth.** The **auto-switch** reroute (always-valid index) has **no
independent teeth** — swapping `set_active(idx)` back to `active = idx` there is
behaviorally identical, so no test can distinguish them. It is a refactor for a single
mutation path / SSOT consistency, covered behaviorally by the pre-existing
`auto_switch_on_faint…` test (which already asserts the post-faint active). We record this
rather than fabricate a fault-injection harness for an unreachable assert (the `debug_assert`
on the infallible path is a regression tripwire, not a gate).

## Consequences

- **Positive:** the pure core can no longer panic-index or seat a fainted active on any
  caller-supplied swap; the swap-legality invariant lives in `game-core` (ADR-0003 SSOT
  restored), removing an M16-PvP panic landmine. No player-facing behavior change (the path
  is unreachable in valid play; production swaps are server-pre-validated).
- **Accepted residuals (recorded, not fixed here):**
  - **(a) Field-level privatization is parked.** `BattleSide.active` stays `pub`, so a raw
    `side.active = x` write outside the resolver is still *representable* (it just no longer
    happens in the resolver). Full type-level unrepresentability needs a wider, serialized
    touch-set (server-module + out-of-touch-set test fixtures) — a follow-up slice. The
    `pub` field carries a doc-comment naming `set_active` as the sole sanctioned mutator.
  - **(b) `resolve_turn` charges a turn on a rejected swap; `resolve_player_swap` charges
    nothing.** A deliberate, documented asymmetry (see §2); neither is reachable with an
    illegal swap in production. M16 defines its own PvP swap/turn policy at the reducer.
  - **(c) The auto-switch reroute has no independent teeth** (§ proof-of-teeth) — by
    construction, not by omission.
- **References:** ADR-0003 (rule SSOT / functional core), ADR-0042 (battle table public PvE
  — same event-stream/no-replay rationale), ADR-0048 (M8.5a battle security — same slice
  family), ADR-0049 (panic-as-content-invariant / reject-not-clamp — the policy this slice
  extends to the swap path).
- **Follow-ups:** a slice with a server-module-inclusive touch-set privatizes
  `BattleSide.active` (validating constructor + getter, migrate the `server-module` literals
  and test fixtures) to close residual (a); M16 defines the PvP simultaneous-turn swap
  semantics that would resolve residual (b).
