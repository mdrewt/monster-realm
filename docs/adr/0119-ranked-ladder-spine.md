# ADR-0119 — Ranked ladder spine: persistent profile, integer Elo, once-only rating funnel, PvE-path PvP closure

**Status:** Accepted
**Date:** 2026-07-16
**Slice:** m17a
**Supersedes:** —
**Amends:** ADR-0109 (PvP orchestration — terminal-commit sites unified into one settle funnel)
**Subsystems:** battle, security-authz, schema-persistence
**Decision:** Persistent world-readable `profile` table + pure integer-Elo `game-core::ranking` + a single `settle_pvp_battle` funnel (sole `apply_pvp_rating` caller) + PvP-reject guards on the four PvE battle reducers, eval-pinned in-slice.

---

## Context

M17 (spec: `M17-ranked-ladder.spec.md`, elaborated m17a) makes PvP matter over time: a persistent Elo
rating + leaderboard. The rating must survive disconnects, so it cannot live on the ephemeral `player`
presence row (deleted in `on_disconnect`). M16 (ADR-0109) left all decisive PvP outcomes flowing through
two structurally identical terminal-commit sites in `pvp.rs`; M17 attaches the rating stake to those
outcomes, which raises three integrity requirements: exactly-once application, module-write-only rating,
and closure of every path by which a PvP battle could reach (or dodge) a decisive outcome outside the
funnel.

Build-time discovery (scope-verify): the PvE battle reducers `submit_attack`, `swap_active`, `flee`, and
`use_battle_item` carry owner-only guards but **no PvP exclusion** — side A of a PvP battle could drive
turns through `submit_attack` (server AI picks side B's moves!), or `flee` to a non-decisive `Fled`
outcome, dodging a rating loss. `attempt_recruit` is structurally safe (requires the wild-only
`battle_wild` row; red-team verified: it errs on a missing row before any outcome write). Also verified:
`forfeit_on_disconnect` routes practice self-battles (`player_identity == opponent_identity`) through
`apply_pvp_forfeit` today — a practice battle matches BOTH its side-A and side-B id lists and is saved
only by the per-loop `outcome != Ongoing` re-check — so the rating must be gated by battle
classification, never by call path.

## Decisions

### D1 — Presence vs progression: persistent `profile` table, never deleted (RL-1/2)

`#[spacetimedb::table(name = profile, public)]`: PK `identity: Identity`, `name: String`,
`rating: i32`, `wins: u32`, `losses: u32`. Public = world-readable for the leaderboard (nothing
sensitive: name is already public on `player`; rating/W/L are the leaderboard's whole point —
ADR-0015 stakes-classification: public-low-stakes). Runtime table, not seeded content → **no
CONTENT_VERSION bump** (ADR-0106 D7 precedent). **No code path deletes a `profile` row** —
`on_disconnect` does not touch it (structural proof-of-teeth pins both; the no-delete scan uses two
needles: the chained `delete` form AND a split-accessor-binding form, the documented evasion).
Additive (ADR-0006): later seasons/decay add columns, never re-key. **No `#[index(btree)]` on
`rating` in m17a** — the m17b leaderboard sorts client-side over a full `profile` subscription; add
an index if/when server-side range queries land.

`get_or_init_profile(ctx, identity) -> Profile` makes the rating path total: find-or-insert with
`rating = INITIAL_RATING (1000)`, `wins = losses = 0`, `name` seeded from the `player` row
(`unwrap_or_default()` → empty string as a defensive fallback only). Verified: all three decisive
paths — both-submit, deadline reaper, disconnect forfeit — run **before** the player row is deleted
(`lib.rs` `on_disconnect` calls `pvp::forfeit_on_disconnect` before deleting the player row), so the
name seeds correctly even on disconnect-forfeit. A future reorder of `on_disconnect` would silently
regress name-seeding (not rating totality) — hence this note.

### D2 — Pure integer Elo in `game-core/src/ranking.rs` (RL-3/4/11/12)

Single file (currency.rs precedent — the swappability boundary is the function signatures, not a
directory; split only if a richer system like Glicko ever needs it). Public API is deliberately
minimal: `INITIAL_RATING`, `apply_elo`, `compute_rating_update`. `K = 32` and `ELO_DIVISOR = 25`
are **private** implementation constants — tuning them is an ADR-level decision, and exposing them
would invite callers to couple to `K/2` instead of to the function contracts.

```rust
pub const INITIAL_RATING: i32 = 1000;
const K: i32 = 32;
const ELO_DIVISOR: i32 = 25;
pub fn apply_elo(winner_rating: i32, loser_rating: i32) -> i32          // Δ ∈ [1, K−1]
pub fn compute_rating_update(winner_rating: i32, loser_rating: i32) -> (i32, i32)
```

- **Linear integer approximation** of the Elo expected-score curve (floats break determinism —
  ADR-0055 bans; client/server parity): `raw = K/2 − (winner − loser).div_euclid(ELO_DIVISOR)`,
  `Δ = raw.clamp(1, K−1)`. Equal ratings → 16. Clamp activation is exact at ±375 (raw hits 1 at
  diff = +375 and 31 at diff = −375); beyond that the bounds hold (e.g. +400 → 1, −400 → 31). Tests
  pin both the ±375 activation thresholds and the ±400 saturated values. Upset (winner rated below
  loser) strictly exceeds its mirror at unclamped margins (±100 → 20 vs 12).
- **`div_euclid`, not `/`**: truncating division rounds toward zero for negative diffs, breaking
  upset/mirror symmetry by one unit around odd multiples of the divisor. Euclidean flooring is
  consistent; pinned by a spot test at diff = −13.
- **Computed in `i64`** internally (cast in, clamp, cast the provably-small result back): kills the
  `i32` subtraction-overflow class. The i64 subtraction of two i32-ranged values cannot overflow.
- **`compute_rating_update` is the SSOT for applying Δ**: returns
  `(winner_rating.saturating_add(Δ), loser_rating.saturating_sub(Δ))`. The server shell never does
  rating arithmetic (functional-core discipline), and RL-11 conservation is unit/property-testable
  without a `ReducerContext`.
- **Zero-sum on the practical domain; saturation documented at the i32 extremes**: one Δ, applied
  ±. Plain `+`/`−` would panic (debug) or wrap (release) at `i32::MAX − 30`-class ratings, so the
  application saturates instead; at the saturation boundary conservation is intentionally violated
  (one side pinned, the other still moves). Reaching the boundary requires ~69 million consecutive
  decided games from 1000 — tolerated as unreachable; a boundary spot test pins the saturating
  semantics so the behavior is deliberate, not accidental. RL-11 conservation is asserted on the
  practical domain (|rating| ≤ ~10^6). No rating floor at 0 — flooring one side would break
  conservation in the reachable range; `rating: i32` may legitimately go negative.
- **No draw handling**: `BattleOutcome` has no `Draw` variant (mutual KO yields a deterministic
  winner from the combat engine); adding one would be a BSATN break (ADR-0006). Elo consumes the
  recorded outcome as-is.

### D3 — Once-only rating: the `settle_pvp_battle` structural funnel (RL-5/10)

The two decisive-commit sites in `pvp.rs` (`resolve_pvp_turn_if_ready` terminal branch;
`apply_pvp_forfeit`) had byte-identical commit ordering. They are unified into ONE private
`settle_pvp_battle(ctx, battle) -> Result<(), String>` which owns the invariant order:

1. `write_back_battle_results` — while the row is still `Ongoing` in the DB (RT-M16-08 GC-sweep
   invariant), log-and-continue (ADR-0077);
2. `battle().update()` to the terminal outcome (before side-B HP — RT-M16-05);
3. **`ranking::apply_pvp_rating(ctx, &battle)`** — the rating is a function of the just-committed
   outcome; infallible (D6);
4. `write_back_party_hp_pvp_side_b` — log-and-continue (ADR-0077);
5. stale `battle_action` sweep (hoisted from the forfeit path; a no-op on the resolve path, which
   already deleted the current turn's actions — SpacetimeDB within-transaction deletes are
   immediately visible, so the sweep re-reads an empty set; commented at the sweep).

Error posture, explicit: steps 1 and 4 are log-and-continue (ADR-0077, cosmetic HP staleness);
step 3 is infallible by construction (D6); the funnel's `Result` exists for genuinely exceptional
step-5/bookkeeping failures and is logged-and-continued by `forfeit_on_disconnect` (which cannot
roll back a single battle) and propagated by the reducer paths.

`settle_pvp_battle` is **the only caller of `apply_pvp_rating`** (pinned by a call-site-count
proof-of-teeth, RT-SEC-02 style, hardened per red-team: the needle counts the bare identifier
`apply_pvp_rating` — catching function-pointer aliasing — across non-test server-module sources
excluding `ranking.rs` itself, expecting exactly 1). Double-count is unrepresentable: there is
exactly one place that commits a terminal PvP outcome, and the rating rides it. **No `rated: bool`
flag on the battle row** — a flag is a second source of truth that can desynchronize; the funnel is
the guard (YAGNI + illegal-states-unrepresentable). The `outcome != Ongoing` re-checks in
`forfeit_on_disconnect`'s two loops and in `pvp_deadline_reaper` are preserved verbatim — they are
the cross-transaction exactly-once defense (red-team verified clean).

### D4 — Battle classification is structural; friendly battles never rate (RL-6)

`is_ranked_pvp(&Battle) -> bool` = `player_identity != opponent_identity && opponent_identity !=
WILD_IDENTITY` — the single classifying predicate. **Home: `guards.rs`** (the battle-authz guard
family SSOT — `require_owner`, `require_pvp_participant` live there; battle.rs already imports from
guards and gains no `ranking` coupling; the eval source-scan stays consistent with the existing
guard-helper scanning). `ranking::apply_pvp_rating` calls `guards::is_ranked_pvp`. Wild battles and
practice self-battles (M12.5e2's `is_practice`) are the "friendly" class and never touch `profile`,
**even through the forfeit path** (which processes practice battles on disconnect today — including
the both-lists overlap; the RL-6 test exercises exactly that scenario). A proof-of-teeth also pins
that `forfeit_on_disconnect`'s collection filters do NOT gain a `player != opponent` short-circuit —
if practice battles were filtered out upstream later, the RL-6 routing assumption would silently
change (reviewer M-2). No `ranked: bool` flag on `battle_challenge`/`battle`: today every
distinct-player battle is ranked; an unranked-PvP flag is additive later (YAGNI).

### D5 — PvE-path closure: reject PvP battles in the four PvE reducers (RL-8/9)

`submit_attack`, `swap_active`, `flee`, `use_battle_item` gain a PvP-reject guard (via the D4
predicate) **immediately after their `outcome == Ongoing` check, before any reducer-specific
validation, content load, or irreversible effect** (reject-not-clamp; uniform placement makes the
source-scan needle unambiguous). Rationale per reducer:
- `submit_attack`/`swap_active`: would resolve PvP turns with the server AI playing the human
  opponent's side — a ranked-farming exploit and an exactly-once violation (decisive outcome outside
  the funnel).
- `flee`: `Fled` is non-decisive → a rating-loss dodge. PvP exit paths are forfeit (deadline/
  disconnect) only, which correctly award the win to the opponent. The client's `canFlee=false`
  (M16b) was never authoritative.
- `use_battle_item`: state mutation outside the both-submit secret-pick protocol (M16 deferred PvP
  items — "additive later" means reject now, lift deliberately later).

`attempt_recruit` needs no guard (wild-only `battle_wild` row requirement).

**The guards are pinned in THIS slice, not m17c** (reviewer B-1): `battle-reducer-security.eval.mjs`
gains a PvP-reject criterion for the four reducers (with bad/good fixtures that bite). Deferring the
eval to m17c would leave a window where a battle.rs refactor could silently drop a security control.
m17c still adds the ranking-security eval family (RL-16) on top.

### D6 — `apply_pvp_rating` is module-write-only and infallible (RL-7)

`pub(crate) fn apply_pvp_rating(ctx, &Battle)` in the new `server-module/src/ranking.rs` domain
module (extends the M8.9 `touches:` vocabulary). It is **not a reducer**; `ranking.rs` declares no
`#[spacetimedb::reducer]` at all (proof-of-teeth scan; the `use spacetimedb::reducer as alias` form
is the documented evasion — the scan also rejects binding `reducer` to an alias in this file). No
client-callable path writes `profile`; a client can never set its own rating. No client-supplied
identity reaches the rating path: winner/loser derive from `battle.player_identity`/
`opponent_identity`, both server-set at battle creation (red-team verified).

**Infallible by construction** (no `Result`): `get_or_init_profile` is total; the two new ratings
come from one `compute_rating_update` call **before** either row write is applied, so a partial
(zero-sum-breaking) write is unrepresentable. This dissolves the fail-loud-vs-log-and-continue
tension for the rating step: there is no failure to police. No-op (early return) unless
`is_ranked_pvp(&battle)` and the outcome is decisive (`SideAWins`/`SideBWins`).

**m17b pre-note (red-team F6):** a future `set_profile_name` reducer will collide with the
"no reducer in ranking.rs" tooth. The amendment path is pre-staged: replace that tooth with
"no reducer that writes `rating`/`wins`/`losses`" and colocate the name-setter with the table,
amending this ADR when m17b lands.

## Consequences

- m17b (leaderboard UI) consumes the generated `Profile` binding + public subscription; m17c pins
  RL-2/7/10 as evals (cross-slice contracts named in the spec §5) on top of the m17a in-slice
  battle-reducer-security extension.
- `write_back_battle_results` stays PvE-shared and rating-free (anti-pattern: a rating write there
  would fire for wild/practice battles and at the wrong ordering step).
- Mutation surface grows (`ranking.rs`, guards, funnel): mutate-server cap re-baselined in this PR
  (ADR-0118 §4); `apply_elo`/`compute_rating_update` tests pin exact values (16/20/12/1/31 and the
  ±375 activation thresholds) so arithmetic/boundary mutants die (nightly mutate-core 0-missed
  obligation).
- Spec deltas from this review pass (single-file `ranking.rs`; RL-11 practical-domain scoping) are
  reflected in the harness spec in the same slice.
- The `trade_offer`-style privacy analysis is trivial here: `profile` exposes only
  name/rating/W/L, all intentionally public (leaderboard).

## Residuals & implementation notes (review-fan record)

- A red-team implementation pass added two additive winner/loser-mapping teeth
  (`rt_m17_01_*` in `pvp_tests.rs`) closing the `SideBWins` tuple-swap mutant class that the
  RL-5 needles alone could not catch (verifier bite-check (iii) confirms they bite).
- Legacy RT-M16-05/RT-M16-08 tests were rewritten (tester) post-funnel: they now pin
  delegation-absence in `apply_pvp_forfeit`/`resolve_pvp_turn_if_ready`; the positive commit
  ordering lives in `m17a_rl10_settle_pvp_battle_ordering`. Their old body-slicing assumed the
  pre-M17 function order and silently scanned the wrong function after the pvp.rs reorder
  (the reorder itself was forced by those same slice assumptions).
- pvp.rs layout note: `apply_pvp_forfeit` now precedes `resolve_pvp_turn_if_ready`; resolve's
  ongoing-path persist deliberately uses a bound-handle form
  (`let battles = ctx.db.battle(); battles.battle_id().update(...)`) so the chained
  `battle().battle_id().update` needle pins ONLY the funnel's terminal commit — do not
  "simplify" it back to the chained form (the rewritten RT-M16-08 forbids it).
- W/L counters use `saturating_add(1)` (red-team F4) — panic-free, mirrors the rating
  saturating policy; saturation unreachable (u32::MAX games).
- mutate-server re-baselined DOWN 309→308 in this PR (ADR-0118 §4 exact-cap): final state
  512 mutants / 308 missed / EXIT 0; all m17a mutants killed (targeted `cargo mutants` on
  `game-core/src/ranking.rs`: 20/20 caught, 0 missed); the 308 survivors are pre-existing
  (`trading.rs` et al.).
- **RESIDUAL (pre-existing M16, NOT fixed here — candidate follow-up slice
  `m17-fix-sideb-guards`):** the ongoing-battle guards in `start_battle`/`begin_encounter`
  (`battle.rs`), `movement_tick` (`movement.rs`), and `heal_party` (`raising.rs`) check only
  the `player_identity` role — a PvP SIDE-B player can open a second concurrent battle or
  heal mid-PvP (HP write-back last-write-wins inconsistency; a heal is silently reversed at
  PvP settle). Red-team verified this does NOT break rating exactly-once and is NOT a
  rating-dodge; `movement.rs`/`raising.rs` are outside m17a `touches:`. Fix shape: extend
  those guards with the `opponent_identity` index check (pvp.rs `is_in_ongoing_battle`
  already covers both roles).
- RESIDUAL (pre-existing M14e): `use_battle_item`'s `.expect("index was valid above")`
  (`battle.rs` ~944) — style inconsistency, unreachable panic; left untouched to keep the
  diff scoped.
