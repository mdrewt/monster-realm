# 0166 — PvP server-guard parity: `with_lead` at the PvP start, a fainted-active attack reject, the both-role warp guard, and trade size bounds

**Status:** Accepted
**Date:** 2026-07-31
**Slice:** 11r-a (M-postgate-eleventh-review-residuals §2; EARS E1–E4)
**Supersedes:** —
**Amends:** ADR-0156, ADR-0122, ADR-0106
**Subsystems:** security-authz, battle, movement-netcode
**Decision:** PvP adopts `BattleSide::with_lead` at both start sites and rejects an Attack from a fainted active; the warp guard moves to the both-role ADR-0122 SSOT; `propose_trade` gains O(1) size bounds ahead of its O(N) dedup.

**Scope, stated up front:** this slice ports the PvE-only halves of ADR-0156 to PvP and closes
two guard gaps. It changes no schema, no `game-core` rule, and no predictor/netcode/RLS surface.
`PvpAction::Swap` is deliberately left unguarded (D2).

## Context

ADR-0156 D7 disclosed that its fixes covered **PvE only** and named `pvp.rs` adoption as
residual P1 ("recommended as the immediate next slice; ranked play is the higher-stakes
surface"). The eleventh multi-lens review (2026-07-31 @ `3063149`) re-verified that residual
and found two further guard gaps on the same server-authority surface. This slice closes all
four.

**D1 is confirmed exploitable, with a PoC.** `start_pvp_battle` pre-checks only that a side has
*some* conscious member (`pvp.rs:252-257`) and then seats `BattleSide { active: 0, team }`
regardless. A party ordered `[0 HP monster, conscious monster]` therefore seats a corpse as the
ranked lead. During plan review a red-team PoC built against this repo's own `game-core`
confirmed the 0 HP lead lands real hits, **swept a 3-monster party, and won the ranked battle**.
It is not a one-turn window: the row self-repairs only when the corpse is actually *hit*
(`resolve.rs:105-129` Faint → auto-switch), so an out-speeding sac-lead is never hit and never
repaired. `calc_damage` never reads the attacker's HP.

**D2, by contrast, is defence-in-depth — and the ADR says so rather than overclaiming.** Once D1
lands, a fainted active with a conscious bench is not reachable through normal PvP turn flow:
`resolve_full_turn` auto-switches on KO (`game-core/src/combat/resolve.rs:447-452`). A
submit-time TOCTOU was hypothesised during review and **disproved**: `resolve.rs:328-342`
(`second_had_faint`) suppresses the slower side's persisted Attack after a same-turn KO, swaps
resolve before attacks (`:271-286`), and every `battle.rs` mutator rejects ranked PvP via
`is_ranked_pvp`. D2's real job is **legacy rows already persisted with a 0 HP active** — exactly
the framing ADR-0156 D2 used for the PvE half.

## Decisions

### D1 — `start_pvp_battle` constructs both sides via `BattleSide::with_lead`; the pre-checks are removed; the rejections are now audited

Both `BattleSide { active: 0, team }` literals are replaced by
`BattleSide::with_lead(team_a)` / `(team_b)` with `.ok_or_else(..)?`, matching
`battle.rs:218-231`. The two `any(|m| !m.is_fainted())` pre-checks at `pvp.rs:252-257` are
**removed**, not kept alongside: `with_lead`'s `None` *is* that precondition
(`game-core/src/combat/types.rs:102-105`), and ADR-0156 D1 already established both the pattern
and the wording. Keeping both would leave dead code whose only effect is to make the adoption
scan ambiguous. Both client-facing error strings are preserved verbatim.

**Beyond parity:** the removed pre-checks rejected **silently**. Every other rejection in
`pvp.rs` audits, and so does `battle.rs:224/229`. The new `ok_or_else` closures therefore call
`log_reject`. They pass **`challenger` / `opponent`**, *not* `ctx.sender` — `start_pvp_battle`
is reached only from `accept_challenge`, where `ctx.sender` is the **acceptor**, so
`ctx.sender` would audit a side-A rejection against the opponent's identity. The sibling helper
in this same file already gets this right (`build_pvp_team` takes an `owner` param,
`pvp.rs:195-216`).

**Newly load-bearing coupling, recorded because nothing pins it:** `with_lead` makes
`abilities.side_a[active]` (`ability.rs:208-217`) depend on `ability_ids_a[i]` being aligned to
`team_a[i]`. `build_pvp_team` satisfies this (both are pushed in one loop), and until now
`active` was always `0` on this path, so the alignment had never mattered. A future refactor
that reorders either vector independently would silently misroute entry abilities. Relatedly,
`apply_entry_ability` cannot currently reduce the seated lead to 0 HP — `AbilityEffect` has
exactly two variants and `EntryHeal` is guarded by `!monster.is_fainted()`
(`ability.rs:86-101,170`) — but that is a *content-schema-dependent* invariant: a future
damaging entry ability would reopen D1 post-construction.

### D2 (anti-decision) — `PvpAction::Attack` gains a fainted-active reject; `PvpAction::Swap` deliberately does NOT

The Attack arm gains the `battle.rs:549-559` guard, sited as its **first** statement — before
the moveset check, so a corpse does not produce the misleading "skill N not in active monster's
moveset", and well before Guard 7's irreversible `BattleAction` insert. Reject-not-clamp: no
silent auto-swap, which is the round-2 surprise ADR-0156 removed.

It is written **inline on the already-bound `my_team`**, not as a `(state, side)` helper. That
was the plan's original design and review rejected it on three counts: both-role coverage is
already structurally proven by the exhaustive match at `pvp.rs:1012-1015` that binds `my_team`
from `my_side`, so a `SideId` parameter re-derives a selection the call site has already made
(an SSOT *regression*); a red-team PoC showed the helper form admits
`reject_if_active_fainted(&battle.state, SideId::SideA)` — which compiles, passes every proposed
test, and leaves **side B's corpse dealing full damage in ranked**; and a helper unit test would
assert only its own `match` arms. The inline form makes the bug unrepresentable instead of
merely tested.

**`Swap` gets no such guard, on purpose.** A player whose active has fainted MUST still be able
to swap out — guarding Swap would soft-lock them. In PvP that is strictly worse than in PvE:
the 60 s deadline reaper (`pvp.rs:54` → `apply_pvp_forfeit` → `settle_pvp_battle` →
`ranking.rs:92`) launders the soft-lock into a **ranked rating loss**. This is the single most
important entry in this ADR: without it, the next consistency-minded security pass adds the
symmetric guard and ships that bug.

For the same reason the rejection message names **only an action the player can actually take**:
`"your active monster has fainted — swap to another monster"`. It must not be copied verbatim
from `battle.rs:556`, which offers "…or flee": `PvpAction` is `Attack | Swap` only and there is
no flee in PvP. The first draft of this slice said "…or forfeit" and the security audit caught
that this is the **same defect wearing a different word** — there is no player-callable forfeit
either. `pvp.rs` exposes seven reducers and none is a forfeit; the only forfeit entry points are
`forfeit_on_disconnect` (a `pub(crate)` lifecycle helper) and the 60 s `pvp_deadline_reaper`, and
`client/src` has no forfeit affordance at all. A legacy corpse-active row is exitable only by
Swap, so a message naming an escape hatch the client cannot render walks the player into the
reaper — a **ranked rating loss**. The gating test pins the absence of both "or flee" and
"forfeit" so neither can be reintroduced. See residual R9.

### D3 — `propose_trade` bounds both sides before any O(N) work; the caps are DoS bounds, not game rules

Two file-local constants (`MAX_TRADE_MONSTERS_PER_SIDE = 64`, `MAX_TRADE_ITEMS_PER_SIDE = 64`)
gate all four client vectors as the reducer's first statement — before the joined-player
lookups and before `validate_proposal`. This follows `battle.rs:62-75`'s bound-before-any-DB-read
ordering; noted honestly, `pvp.rs`'s own siblings bound *later* (`challenge_pvp` at `:694` after
three player lookups, `accept_challenge` at `:853`), so this is a choice between two in-repo
idioms, not a uniform house rule.

**Why 64 and not 6.** No spec, ADR-0106, or `game-core` rule fixes a trade size — so a number
had to be chosen, which makes it a product statement worth recording. An earlier draft proposed
6 (= `PARTY_SIZE`) and it was **wrong**: `propose_trade` never checks `party_slot`, and
`client/src/ui/tradeProposeModel.ts:91-96` builds `offerableMonsters` from **all** owned
monsters with no selection-count gate — boxed monsters are tradeable today, so a 6 cap would
reject legitimate existing UI flows with an opaque server error. The caps exist to bound work,
not to express game design; generous is correct, and `MAX_PARTY_SIZE` is deliberately **not**
reused (a trade is not a party). `n == 0` must pass — one-sided trades are legal, and emptiness
is `validate_proposal`'s cross-side `EmptyOffer` rule (`game-core/src/trading/rules.rs:53-61`),
not restated here. This is why `guards::check_party_size` is **not** reused: it rejects `n == 0`
(`guards.rs:105-108`) and would break every legal one-sided trade.

**What the caps do and do not stop, stated precisely.** They do **not** bound BSATN decode — the
host materialises the argument `Vec` before the reducer's first statement runs. What they bound
is everything after: `validate_proposal`'s unbounded `HashSet` dedup
(`game-core/src/trading/rules.rs:63-90`) and the O(items × inventory-rows) scans at
`trading.rs:278-329`, including the per-item `escrowed_item_qty` double index-chain. Also
recorded honestly: **there is no rate limiting anywhere in this module**, and the "no active
offer" guard bounds *concurrent offers*, not call rate — a rejected proposal creates no row, so
the call loop is unbounded. Post-cap each iteration is O(1), making this an ordinary flood
rather than an amplification.

### D4 — the warp guard uses the both-role SSOT; `unwrap_or(true)` means *skip warp*, not *in battle*

`movement.rs:209-223`'s inline filter queried only `battle().player_identity()`, so a PvP
**side-B** player could walk through a warp mid-battle. It is replaced by
`guards::is_in_ongoing_battle(ctx, p.identity)` (ADR-0122 D1's SSOT, `guards.rs:264`). The
substitution is exactly "the inline filter, plus the opponent role": the SSOT's player arm is
semantically byte-equivalent (neither excludes wild battles on the player side) and the added
opponent arm excludes `WILD_IDENTITY` (`guards.rs:255-258`). Nothing else widens or narrows.

The argument is **`p.identity`**, and this is pinned by a test rather than left to review:
`movement_tick` is scheduler-only, so `ctx.sender` is the **module** identity. A plausible
copy-paste — `is_in_ongoing_battle(ctx, ctx.sender)` — would make the guard always `false` and
warp **every** player out of **every** battle, PvE and PvP alike: strictly worse than the bug
being fixed.

`.unwrap_or(true)` is preserved. Its meaning is "an NPC has no `player` row ⇒ **skip the
warp**" (ADR-0070 home-zone policy), which is the opposite of what the local's former name
(`in_battle`) suggested. The local is renamed `skip_warp` so a future cleanup does not "fix" it
to `false` and start teleporting NPCs out of their home zones. (`npc_tests.rs:351-371` pins
`.unwrap_or(true)` textually and stays green.)

## Consequences

Ranked PvP no longer seats a 0 HP lead, no longer accepts an attack from a corpse, and no
longer lets side B walk out of a battle through a warp tile. `propose_trade`'s worst case
becomes O(1)-bounded before any DB read. No `game-core` behaviour changed, so client prediction
and replay determinism are untouched.

The gating tests are source-text scans where the reducer needs a live `ReducerContext` (the
crate has no reducer-executing harness — `battle_tests.rs:2151-2153`). Every scan pins the
**argument**, not merely the call: plan review demonstrated five distinct evasions that passed
presence-only needles, including a swapped-argument `with_lead(team_b)` / `with_lead(team_a)`
that would make each player play the *other's* monsters and write post-battle HP back onto the
wrong rows (`check_team_coupling`, `guards.rs:124`, compares lengths only — invisible when both
parties are the same size).

### Residuals (named, not done)

- **R1 — `challenge_pvp` never validates party consciousness** (`pvp.rs:746-771`). Only
  `start_pvp_battle` does, and a reducer `Err` rolls the transaction back, so the
  `battle_challenge` row survives as **Pending**. Challenging with an all-fainted party makes
  the target's `accept_challenge` always error, while guard 5b (`pvp.rs:716`) blocks the target
  from opening their own challenge until they decline or the 120 s TTL reaps it. Repeatable at
  zero cost. In-file but a behaviour change beyond EARS E1–E4 — deliberately not taken here.
- **R2 — legacy corpse-active PvP `battle` rows** are exitable only by Swap. D2 blocks the
  misleading attack, but a player who retries Attack is reaped into a rating loss at 60 s. A
  one-shot reseat (or repair-on-read in `resolve_pvp_turn_if_ready`) would close it. Same
  accepted-risk shape as ADR-0156 P3, with higher stakes.
- **R3 — `evals/zone-warp-server-runtime.eval.mjs` W3 is now fully vacuous.** It counts
  `BattleOutcome::Ongoing` occurrences after `warp_at(`; its docstring assumes the
  grass-encounter guard *precedes* `warp_at`, which was **already false at HEAD**
  (`warp_at` `movement.rs:205`, grass guard `:251`). Our change takes the count 2 → 1, so it
  now passes even with the warp guard deleted entirely. Real protection moved to
  `movement_tests.rs`. One-line fix: change the needle to `is_in_ongoing_battle(`. Route to
  **11r-c** (owns both `movement.rs` and `evals/`).
- **R4 — the grass-encounter pre-check (`movement.rs:251-256`) has the same single-role bug.**
  Not a hole — `begin_encounter` re-guards with the both-role SSOT and rejects — but
  `ctx.random()` is drawn at `:272` for a player who cannot get an encounter, weakening the
  draw-at-most-once fairness rationale stated at `:239-242`. Fixing it changes encounter
  RNG-draw ordering, outside this slice's EARS. Route to **11r-c**/11r-g.
- **R5 — SSOT homes deferred by touch-set, not by preference.** `guards.rs:98-134` is the
  declared home for pure, `ReducerContext`-free validators, which is where the trade-size cap
  belongs; and a shared `scan_helpers` test module (this slice adds the 4th local
  `strip_rust_comments` copy, in `movement_tests.rs`) needs `lib.rs`. Both files are outside
  11r-a's `touches:`. Route to a slice that owns them.
- **R6 — the client has no trade selection-count gate.** `buildProposeSubmission`
  (`tradeProposeModel.ts:129-152`) gates on `length > 0` only, so a >64 selection now yields an
  opaque server reject with no UI affordance. Route to a client slice.
- **R7 — `confirm_trade`'s per-unit transfer loop** (`trading.rs:644`,
  `for _ in 0..qty { consume_one(..) }`, `qty ≤ MAX_ITEM_STACK` = 9999) is one indexed scan plus
  one row update per iteration. Real holdings bound it in practice; out of D3's scope.
- **R9 — there is no player-callable forfeit, and now no client affordance behind D2's reject.**
  A PvP player whose active has fainted can press Attack, receive an authoritative `Err`, and have
  no rendered way to act on it other than Swap; the only forfeits are disconnect-driven or the 60 s
  reaper. D2 names Swap for exactly this reason, but the underlying gap is a product one: either
  add a `forfeit_pvp(ctx, battle_id)` reducer guarded by `require_pvp_participant` + ongoing
  (delegating to `apply_pvp_forfeit`), or surface a swap affordance on the fainted-active state.
  Route to a PvP client/server slice — `client/src/ui/battleModel.ts:262` also re-derives
  `is_fainted()` as `currentHp > 0` for its swap list, which is the same class.
- **R10 — the sim-harness models a movement rule the server does not have.**
  `sim-harness/src/world.rs:100-103` short-circuits the entire move drain for `battle_locked`
  characters and its comment at `:84-89` claims it is *"mirroring the server's battle-lock check in
  `movement_tick`"*. There is no such check: `authorize_move` (`guards.rs:66-100`) and
  `enqueue_move`/`set_move`/`clear_queue` have no battle gate, and after this slice `movement_tick`'s
  only battle references are the warp guard and the grass pre-check. The server model is "in battle
  ⇒ warp skipped, movement continues"; the harness model is "in battle ⇒ frozen". Since the harness
  is the ADR-0013 convergence proof and `tick_zone` is a second hand-written implementation of the
  warp resolution, this drift matters. Pre-existing — but this is the slice that rewrote the guard,
  so the comment is now demonstrably false. Route to **11r-c** (which owns both the drain-time lock
  and `movement.rs`); the parity test it should add is: a battle-locked character stepping onto a
  warp tile ends up **moved but not warped**.
- **R11 — the `propose_trade` size rejections are not audited.** `check_trade_side_size(..)?`
  propagates without `log_reject`, so a cap-flood produces no reject telemetry — unfortunate for the
  one guard whose purpose is bounding abuse. There is in-function precedent for silence (the two
  joined-player checks also do not log), so this is left consistent rather than fixed piecemeal.
- **R8 — `docs/adr/README.md:16` "Next free number" is stale** (says 0165; 0165 exists, and
  this ADR makes 0166 taken). It is hand-maintained and gated by nothing — the exact drift class
  11r-d flagged. Not bumped here: the ADR index is supervisor-owned.

## Considered alternatives

- **Keep the `any(|m| !m.is_fainted())` pre-checks alongside `with_lead`.** Rejected: dead code
  that makes the adoption scan ambiguous; `None` already *is* the precondition.
- **A `reject_if_active_fainted(&BattleState, SideId)` helper for D2.** Rejected — see D2. A
  `(&BattleSide)` variant was also considered and rejected as an abstraction with one caller
  whose test would be a tautology.
- **Reuse `guards::check_party_size` for the trade caps.** Rejected: it rejects `n == 0`, which
  would break every legal one-sided trade, and it encodes a *party* rule.
- **Cap trades at `PARTY_SIZE` (6).** Rejected — see D3; boxed monsters are tradeable today.
- **A brace-matched block extractor for the E3 scan.** Rejected in favour of one composite
  adjacency needle on the whitespace-squashed body (the `raising_tests.rs:883-914` precedent):
  simpler *and* stronger, since it pins adjacency rather than co-occurrence and makes the
  legitimate `player_identity()` at `movement.rs:254` a non-issue rather than a hazard to
  design around.
