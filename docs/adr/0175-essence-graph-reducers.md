# 0175 — Essence-graph reducers: quality-time semantics, auto-evolution, battle credits (EG2)

**Status:** Accepted
**Date:** 2026-08-05
**Slice:** EG2 (M-evolution-essence-graph — EARS EG2-1..EG2-13)
**Supersedes:** —
**Amends:** ADR-0174
**Subsystems:** evolution-fusion, battle, movement-netcode
**Decision:** Land the essence-graph write layer — apply_evolution/check_and_evolve with chain cascade, essence_train/consume_crystalized_essence, Trust/Quality-Time credits — defining the EG1-frozen quality-time columns as bounded-gap active-playtime accrual.

## Context

EG1 (ADR-0174) froze the schema and the pure gate layer; this slice lands the reducers that
write it. Design authority: harness `adr/0019-evolution-fusion-model.md` Amendment 2026-08-02
+ addenda; implementation spec `M-evolution-essence-graph.spec.md` §2 EG2-1..EG2-13. Several
"EG2 semantics" items were deliberately left open by EG1 (schema.rs's own comment on the
quality-time columns); this ADR records how they were resolved and every deviation from the
spec's literal prose. Plan reviewed by red-team + reviewer lenses before tests were written;
the two HIGH findings (D5, D13 below) reshaped the plan.

## D1 — Quality-Time accrual: bounded-gap active-playtime, NOT a per-calendar-day counter

The 0019 amendment's literal wording ("a per-day counter credited once per calendar day") is
superseded by the EG1 freeze itself: the shipped tick bands `[10, 50, 150, 400]`
(`game-core/src/evolution/eligibility.rs`) would take 400 *days* to top out under a literal
reading, and EG1 froze three ms-granularity accumulator columns a day-counter would never
need. The amendment's actual intent — active-engagement time, hard-capped per day, never
scheduled — is honored by bounded-gap crediting:

- `quality_time_window_start_ms` = last-accrual anchor (server clock, `now_ms(ctx)` only).
- gap = now − anchor (saturating; a backwards clock re-anchors with no credit).
- gap < `QT_MIN_WRITE_GAP_MS` (5 s): **no DB write, anchor kept** — sub-threshold calls batch
  against the older anchor, so no time is lost and the movement hot path writes each party
  monster's row at most once per 5 s.
- gap > `QT_IDLE_GAP_MS` (120 s): re-anchor only, credit 0 — the player was away; idle time
  never credits (the first-ever call, anchor 0, lands here by construction).
- else credit `min(gap, QT_DAILY_CAP_MS − window_ms)` where `quality_time_window_ms` = ms
  credited in the current UTC day (reset when `day(now) != day(anchor)`, day = ms/86 400 000)
  and `QT_DAILY_CAP_MS` = 2 h — defense-in-depth so one marathon session cannot blow through
  the whole tier ladder.
- `quality_time_accum_ms` accumulates credit and converts to whole ticks at
  `QT_TICK_MS` = 60 000 (1 tick ≈ 1 active minute) into `quality_time_ticks_total`
  (saturating), keeping the remainder.

Tier pacing lands at ≈10 min / 50 min / 2.5 h / 6.7 h of genuinely active play — a
multi-session curve consistent with the shipped bands. All four constants are server-local,
playtest-tunable placeholders (spec §6); the *shape* (gap-bounded, capped, never scheduled)
is the decision. `MonsterPub` is re-projected only when `quality_time_tier` actually changes
— `pub_from_monster` derives every public field from the private row, so an unchanged tier
is a byte-identical projection and skipping the write is a provable no-op (public-row churn
on the movement path matters).

## D2 — care() at max bond: AtMaxBond becomes bond-unchanged-continue (spec EG2-5 honored over EG1 carry-over)

EG1 kept the frozen `bond` write (ADR-0174 D2); EG2-5 adds the Trust increment. Left as-is,
`apply_care`'s reject-at-255 would permanently freeze Trust growth for any monster after ~51
cares (~13 days of routine play) — a live gate silently starved by a dead column (both review
lenses rated this HIGH). `evaluate_care` now maps `CareError::AtMaxBond` to a
bond-unchanged continuation while **every other reject (cooldown included) still gates
unconditionally** — a maxed-bond monster earns Trust at exactly the same cooldown-limited
rate as any other, never faster. `apply_care` remains the called SSOT (the
raising-reducer-security gate's delegation check still binds). The bond write itself stays
until Migration B (EG5-6) removes the column.

## D3 — Auto-evolution: check_and_evolve/apply_evolution shape

- `apply_evolution(ctx, monster_id, path: &EvolutionPathRow)` is the ONE transform-and-write
  path (zero essence, fresh target-species tier, dual-write, Trust/QT untouched), factored
  out of `evolve()`; both `evolve()` and `check_and_evolve` call it.
- `check_and_evolve(ctx, monster_id)` reads the **DB `evolution_path` rows** via the
  `from_species` btree index + `marshal::evolution_path_from_row` — the same source
  `evolve()` and the EG4 client read. (`content_cache::cached_evolution_paths()` is
  `#[cfg(test)]`-gated and out of this slice's touches.)
- Chain evolution is an **iterative** loop with an explicit counter capped at
  `MAX_EVOLUTION_CHAIN_STEPS = 7` (R11's tier cap 5 + 2). The cap is structurally
  unreachable for R5-valid content; hitting it logs a distinct `log::error!` (invariant
  violation signal), never a silent stop.
- NEVER battle-guarded: at the `write_back_battle_results` call site the battle row is still
  `Ongoing`; the standard guard would silently disable auto-evolution from the one site
  covering essence+Trust+level together. The other call sites are battle-guarded before
  their own mutation.
- Call sites (tails, after the caller's own dual-write, fresh-find semantics):
  `care`, `train`, `essence_train`, `write_back_battle_results`, `enqueue_move`
  (whole `lead_party` id list), **and `consume_crystalized_essence` — a sixth site,
  deviating from EG2-8/EG2-12's "exactly five"**: the spec's own completeness argument
  ("anywhere a gate value can change, this set already has a call site") omits EG2-4, which
  mutates essence; without the tail a full-bar crystal feed would not evolve until an
  unrelated later action, contradicting EG2-1's "evolves automatically the instant it
  becomes eligible" and EG3-8's one-shot-unlock intent. Spec correction flagged to the
  supervisor, not applied here.

## D4 — Battle credits (EG2-7): ordering, faint placement, day cap

- Wild classification: `is_wild_battle(b) = opponent_identity == WILD_IDENTITY` — one
  predicate exempts both practice (player == opponent) and PvP (third identity), closing the
  collusion-farming vector.
- Faint penalties (`trust_unfavorable_count += 1` per fainted party member, wild only) run in
  their own loop **before** the `SideAWins` block — that block early-returns on corrupt loser
  data, and faints must credit on ANY wild outcome (loss, flee, disconnect write-back).
- Win credits (essence `max(1, loser_bst/30)` of the **defeated** species' affinity;
  Trust-favorable once per UTC day) are computed independent of the `winner_lvl` parse: a
  corrupt winner level skips **XP only**, never essence/Trust/QT — the same discipline the
  RT-WB-CURRENCY-01 fix established for currency in this exact function.
- Day cap comparator: credit iff `day(now) > trust_favorable_battle_day_epoch` (`>`, not
  `!=`): a server clock rewind causes a bounded (≤24 h) credit lockout, never a
  double-credit. UTC-day granularity **deviates from EG2-7's "rolling-24h" prose** — the
  EG1-frozen `u32` day-epoch column cannot hold a rolling ms timestamp; accepted, with the
  known midnight-straddle double-dip (~2 credits minutes apart at most once) as a low-stakes
  cosmetic artifact.
- Recruit-success stays credit-exempt (it routes through `write_back_party_hp`, not
  `write_back_battle_results`) — deliberate, mirroring the no-XP-on-recruit precedent
  (ADR-0047), not an oversight.

## D5 — essence_train / consume_crystalized_essence

Both live in `raising.rs` beside `care`/`train` (evolution.rs stays a gate-field-free zone,
ADR-0174 D4b). Shared cooldown anchor `last_essence_train_at_ms` (5 h proposed), predicate =
`game_core::is_cooldown_ready` (SSOT). Essence writes go through one `grant_essence` helper:
`saturating_add(amount).min(ESSENCE_SOFT_CAP = 999)` — clamp, never reject (EG1-1).
`consume_crystalized_essence` carries the full guard set (ownership, both-role battle,
monster escrow, item escrow) and exactly two decision rejects (no `essence_affinity`;
cooldown), both **before** `consume_one` — a reject never burns the item. `ItemDef`
essence fields come from the compile-time content registry (`cached_items()`), per ADR-0174's
consequence note. Policy constants are server-module-local (game-core is outside this
slice's touches; EG5 may promote them beside `battle_currency_reward`).

## D6 — Gate deltas (no-idle-accrual + evolution-reducer-security + the EG1-11 scan)

- `GROWTH_WRITERS` += `accrue_quality_time`, `apply_evolution`, `essence_train`,
  `consume_crystalized_essence`, `check_and_evolve` (writes nothing itself, but listing it
  makes Check B mechanically ban a scheduled reducer from ever calling it directly — the
  eval half of EG2-9), `grant_essence`. `evolve` STAYS listed post-refactor for the same
  Check B reason (not a stale leftover).
- `GROWTH_FIELDS` += all 16 new private `Monster` columns now (8 essence, 3 trust, 4
  quality-time, `last_essence_train_at_ms`): the names were frozen by EG1, and deferring to
  EG5-3 would leave Check A blind to the new resources for the whole EG2→EG5 window.
  Pub-side fields and the `bond` removal remain EG5-3's.
- `evolution-reducer-security.eval.mjs` (gate-forced touches-delta): E1/E2 stay scoped to
  `evolve`; the dual-write/SSOT-transform checks move to `apply_evolution`'s body; a new
  check requires `evolve`'s body to call `apply_evolution(` so delegation can't be satisfied
  by an orphan helper. EG5-2 still owns the new-reducer invariants.
- The EG1-11 banned-needle scan narrows ONE needle: `eligible_evolution_paths(` becomes a
  body-scoped ban on `evolve()` (EG2-1's targeted-lookup rule) plus a POSITIVE requirement
  in `check_and_evolve`'s body (EG2-11 mandates the full-set query there), with two new
  teeth closing the loop-reimplementation escape: exactly one `path_satisfied(` and no
  `.collect` in `evolve`'s body. The other nine needles stay file-scoped and bind the new
  functions too.

## Consequences

- Auto-evolution is live end-to-end the moment EG3 ships content; until then every
  `check_and_evolve` is a 0-eligible no-op (evolution stays dark, per ADR-0174's accepted
  window).
- The client cannot yet render essence-item info (`ItemRow` carries no
  `essence_affinity`/`essence_amount`; the reducer reads the content registry) — flagged as
  a future additive-migration follow-up, supervisor's call.
- Six accrual/auto-evolve call sites, not five — spec correction owed (see D3).
- All pacing constants (5 h cooldown, +5 train amount, 999 cap, bst/30 divisor, QT windows)
  are playtest placeholders; the shapes are the decisions.
