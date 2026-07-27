# 0156 — a 0 HP monster is never seated as lead (PvE), and a fainted player active cannot submit an attack

**Status:** Accepted
**Date:** 2026-07-27
**Slice:** battle-0hp-fix (M-postgate-battle-0hp-fix — 0hp lead-monster battle-start defect; EARS E1–E5)
**Supersedes:** —
**Amends:** ADR-0155
**Subsystems:** battle
**Decision:** PvE lead selection moves into `BattleSide::with_lead` (first `hp > 0` slot, team order preserved) and `submit_attack` rejects a fainted side-A active at the reducer boundary; the pure resolver is NOT hardened (D3).

**Scope, stated up front so the title is not read as unconditional:** D1 covers the two **PvE**
construction paths only. D2 guards **side A**, in **`submit_attack`**, in **PvE** only. A legacy
row's side-B 0 HP active still acts and still deals full damage — that is not an oversight, it is
the self-repair mechanism D3 depends on. Ranked PvP is untouched and still seats a 0 HP lead
(D7 / residual P1).

## Context

Drew's r2 playtest (episode `r2-2026-07-26`, ledger items 005/030/031/036–039) reported: when
the lead party monster has 0 HP at battle start, that monster is still sent out for round 1;
clicking an attack button appears to process the attack; round 2 then silently swaps to the
next monster, with no player-visible prompt explaining the switch.

The report is accurate and the mechanism is fully traced:

1. **Root cause — hardcoded lead.** `start_battle` (`server-module/src/battle.rs`) and
   `begin_encounter` construct `BattleSide { active: 0, team }`. The only precondition is
   "the side has *some* conscious member" — nothing requires that member to be slot 0. A
   party whose slot-0 monster is at 0 HP therefore seats a corpse as the active lead.
2. **The apparent hit.** `submit_attack` validates only that `skill_id` is in
   `side_a.active_monster().known_skill_ids`, then calls `resolve_full_turn`.
   `calc_damage` (`game-core/src/combat/damage.rs`) never reads the attacker's HP, so the
   0 HP lead deals **full damage**. That is Drew's "appears to process the attack" — it is
   not cosmetic, the hit is real.
3. **The silent swap.** When the enemy's counter-attack lands, `resolve_one_attack` sees the
   defender `is_fainted()` (it was already 0 HP), emits `Faint`, auto-switches to
   `next_conscious_index()` and emits `Switch`. That is Drew's unexplained round-2 switch.

The pre-existing guard `second_had_faint` (`game-core/src/combat/resolve.rs`) suppresses the
slower side's attack when the *faster* side KO'd it **this turn**. It keys on emitted `Faint`
events, so a monster that was already at 0 HP when the turn began emits nothing and is not
covered. That gap is the whole bug.

This also refutes a claim in ADR-0155 ("`sideA.active` is bounds-guarded and the server
auto-switches on faint, so a fainted active never coexists with `Ongoing`"). That claim is
true *mid-battle*; it is false at battle **construction**. See *Amendment to ADR-0155*.

## Decision

### D1 — lead selection is a `game-core` rule, called by the shells (EARS E1)

Add `BattleSide::with_lead(team: Vec<BattleMonster>) -> Option<BattleSide>` to
`game-core/src/combat/types.rs`: `active` is the **first** index with `current_hp > 0`;
`None` when the team is empty or entirely fainted. It becomes the second sanctioned way to
establish `active`, alongside `set_active` (ADR-0053).

`start_battle` and `begin_encounter` adopt it for **both** sides, which folds away their
separate "has a conscious member" checks — the constructor's `None` *is* that check. The four
existing reject strings and both `start_battle` `log_reject` audit calls are preserved verbatim;
`begin_encounter` had no audit call and deliberately gains none. One **new** string is
introduced — `"wild opponent has no conscious monster"` for `begin_encounter`'s side B — which is
provably unreachable (`derive_stats` yields `hp >= level + 10 >= 11` for any base stat, IV or EV,
and saturates high rather than wrapping; `Level::new` rejects 0). It exists only because routing
side B through the constructor too is what keeps a fourth `BattleSide { .. }` literal — and thus
a reopened hole — out of the file.

**`with_lead` MUST NOT reorder `team`.** `side_a.team[i]` is positionally coupled to
`party_monster_ids[i]` for HP write-back (`write_back_party_hp`), the XP award loop, and the
ability/status stores, and `check_team_coupling` compares **lengths only** — it cannot detect
a permutation. An implementation that "helpfully" rotates the first conscious monster into
slot 0 would satisfy a naive `!active_monster().is_fainted()` assertion while silently writing
one monster's post-battle HP onto another's row and awarding its XP to the wrong monster. The
constructor computes `active` and nothing else; a full-`Vec` equality test pins this.

### D2 — a fainted active is rejected at the reducer boundary, not in the pure core (EARS E2)

`submit_attack` rejects with `Err` when `side_a.active_monster().is_fainted()`, sited after
the `is_ranked_pvp` guard and **before** the moveset check (a corpse should not produce
"skill N not in active monster's moveset"). Reject-not-clamp: the reducer does **not**
auto-swap to a conscious monster, because a silent auto-swap is precisely the round-2 surprise
Drew reported, promoted to a feature.

The guard is defence for **legacy `battle` rows** — rows already persisted in the live
playtest DB with a 0 HP active. D1 is start-time-only and does not retroactively repair them.

### D3 — REJECTED: hardening the pure resolver against a fainted actor

The obvious companion change — an early return at the top of `resolve_one_attack` when the
**acting** side's active is fainted — was planned, reviewed by three independent lenses, and
**rejected**. Recording why, because it is the non-obvious call in this slice and it looks
like an omission:

- **It creates a non-terminating fixpoint.** A red-team pass built the state where *both*
  sides' actives are fainted and ran it 100 turns under the proposed guard: no `Damage`, no
  `Faint`, no `Switch`, no outcome change — only `turn_number` advances. Under the **current**
  code the identical state fully recovers in **2 turns**, because each corpse's attack lands on
  the other corpse and re-triggers the faint/auto-switch branch. The guard deletes the only
  mechanism that repairs a 0 HP active. In ranked PvP (where `flee` is rejected and
  `is_in_ongoing_battle` locks both players out of every other path) the exit degenerates to
  "whoever disconnects first takes a rated loss."
- **It is unreachable on well-formed state.** After D1, the three faint sources — attack KO,
  DoT (`status.rs`), weather chip (`weather.rs`) — each auto-switch or set a terminal outcome,
  and `set_active` refuses a fainted target. A fainted active cannot coexist with `Ongoing` in
  a battle created after this slice. The guard would fire only on malformed legacy rows, which
  D2 already covers at the boundary.
- **Its rationale was inverted.** It was justified as "the general form of `second_had_faint`".
  It is not: `second_had_faint` fires when a side was KO'd *this turn* and auto-switched to a
  **conscious** backup — a case the proposed guard cannot see. The two rules have disjoint
  firing conditions. Publishing the "general form" framing would invite a later reader to
  delete `second_had_faint` as redundant, handing every KO'd side a free retaliation.
- **It contradicts a project standard.** `standards/principles.md`: *defensive programming at
  trust boundaries only — not inside pure core code.* The trust boundary is the reducer (D2).

Consequence, stated plainly: a fainted active **remains a valid target** for enemy attacks,
DoT and weather chip. That is not an oversight — it is the self-repair path for legacy rows.

### D4 — the 0 HP / double-KO / speed-tie rules, pinned as-built (EARS E4)

This slice **documents** these rules; it does not change them. A change is a separate slice.

- **R1 — lead selection.** The first slot with `hp > 0`, lowest index wins. Enforced by
  `BattleSide::with_lead` (D1).
- **R2 — a fainted actor does not act.** Enforced at the reducer boundary (D2). Deliberately
  *not* enforced in the pure core (D3).
- **R3 — a KO by the faster side prevents the slower side from acting.** Pre-existing
  (`second_had_faint`). Orthogonal to R2, not a special case of it.
- **R4 — speed ties** are broken by the injected `variance.speed_tie_breaker`, derived
  deterministically from `ctx.random()` (ADR-0003 injected-RNG). Pinned as a decision, not an
  accident.
- **R5 — double KO.** A true simultaneous *attack* double-KO is impossible: R3 cancels the
  slower side's action. A residual mutual wipe can only arise from the post-turn DoT / weather
  chip phases, which iterate `[SideA, SideB]` in fixed order and `break` on a terminal outcome
  — so the first side to faint with no backup loses, and `BattleOutcome` has no `Draw`.
- **R6 — replacement after a faint** is automatic and engine-picked (`next_conscious_index`),
  with no player prompt, and the replacement does **not** act on its switch-in turn.

#### Comparator evidence (ledger item 039 — judgment call, researched not dictated)

| System | Lead selection | Already-0-HP actor | Double KO | Speed tie | Replacement |
|---|---|---|---|---|---|
| Pokémon mainline | "the first Pokémon that has not fainted in the party list is the one that will be drawn first" — fainted skipped [1] | Not representable: 0 HP ⇒ faint ⇒ leaves the battle immediately [2] | Gen 1–4 / Smogon: tie. Self-KO Clause, when in force: the user of Explosion/Destiny Bond/Perish Song loses [4] | Random 50/50, re-rolled each turn [3] | Player prompt; replacement cannot move that turn |
| Pokémon Showdown (source) | Team order; fainted never active | `runAction`: `case 'move': if (action.pokemon.fainted) return false;` — a **state** check, not an event check [5] | `checkWin`: both sides empty ⇒ `win(gen > 4 ? faintData.target.side : null)`; `win(null)` ⇒ `tie`. Gen ≤ 4 draw, gen 5+ the last-faint's side wins [5][6] | `speedSort` → `prng.shuffle` on equal keys [5] | Forced `requestState: 'switch'`; `chooseSwitch` rejects a fainted target; replacement cannot move that turn [7] |

Beyond the two Pokémon rows, the comparators document only speed-tie behavior: Temtem uses a
deterministic alternating "speed arrow" that flips owner after each tie [8], Cassette Beasts
resolved ties host-authoritatively as of 1.6.2 with a stated plan to move to random [9], and
Coromon uses a random breaker [10]. No authoritative source was found for Nexomon on any of
these columns — recorded as unknown rather than guessed.

Where we conform and where we diverge:

- **R1 matches Pokémon mainline exactly** [1]. Before this slice we diverged; D1 closes it.
- **R2's predicate matches Showdown's** — Showdown checks `pokemon.fainted` as *state*, which
  is exactly why an event-scan (`second_had_faint`) is insufficient [5]. We enforce it one
  layer out (the reducer) rather than in the resolver, for the D3 reasons.
- **R5 aligns with the gen-5+ rule** rather than the gen-≤4 draw: `BattleOutcome` has no
  `Draw` variant, and our fixed `[SideA, SideB]` evaluation order yields the same winner the
  "last faint's side wins" rule would. Recorded as a deliberate simplification.
- **R4 is well precedented** as a *non-random* deterministic breaker (Temtem's alternating
  speed arrow [8], Cassette Beasts' host authority [9]); ours is stronger because it is
  replayable and RNG-injected. No change needed.
- **R6 diverges from every comparator on the prompt** (all of them prompt for the
  replacement). That is a pre-existing scope decision, not revisited here. The sub-rule
  "the replacement does not act on its switch-in turn" matches every comparator.

Sources: [1] [Party — Bulbapedia](https://bulbapedia.bulbagarden.net/wiki/Party) ·
[2] [Fainting — Bulbapedia](https://bulbapedia.bulbagarden.net/wiki/Fainting) ·
[3] [Stat — Bulbapedia](https://bulbapedia.bulbagarden.net/wiki/Stat) ·
[4] [Tie Conditions](https://www.smogon.com/forums/threads/tie-conditions.3469952/) and
[Self-KO clause](https://www.smogon.com/forums/threads/self-ko-clause.3464071/), Smogon ·
[5][6] [pokemon-showdown/sim/battle.ts](https://github.com/smogon/pokemon-showdown/blob/master/sim/battle.ts) ·
[7] [pokemon-showdown/sim/side.ts](https://github.com/smogon/pokemon-showdown/blob/master/sim/side.ts) ·
[8] [Combat — Temtem Wiki](https://temtem.wiki.gg/wiki/Combat) ·
[9] [Multiplayer — Cassette Beasts Wiki](https://wiki.cassettebeasts.com/wiki/Multiplayer) ·
[10] [Stats — Coromon Wiki](https://coromon.wiki.gg/wiki/Stats).

### D5 — swapping INTO a 0 HP monster: verified, no code change (EARS E3)

The spec asked us to verify rather than assume. Both layers already reject:

- `swap_active` checks `team[idx].is_fainted()` before mutating anything, and separately
  rejects out-of-bounds and already-active.
- `BattleSide::set_active` returns `SwapError::Fainted`, leaving `active` unchanged — the
  ADR-0053 sanctioned-mutator contract.

**Verified, no hole found.** That is a result, not a gap. Gating tests pin both layers.

### D6 — the no-soft-lock contract

`swap_active` and `flee` deliberately do **not** gain a fainted-active guard. Swapping *away*
from a 0 HP active and fleeing are the player's recovery paths out of a legacy row; guarding
them "for consistency" would strand the player in an unplayable `Ongoing` battle. Pinned by an
anti-regression test that requires the discriminating expression
`side_a.active_monster().is_fainted()` to be **absent** from both reducer bodies and
**present** in `submit_attack` — note this is distinct from `swap_active`'s legitimate
`team[idx].is_fainted()` check on the swap *target*.

State walk for a 0 HP active with `Ongoing`: `submit_attack` rejects (D2); `swap_active`
succeeds; `attempt_recruit` on failure lets the wild strike the corpse, which self-repairs the
row; `flee` exits unconditionally in PvE. There is no state with no exit.

### D7 — PvP is NOT fixed by this slice (hidden dependency — supervisor must re-serialize)

`server-module/src/pvp.rs` carries the **identical** defect: `start_pvp_battle` has the same
`any(conscious)`-then-`active: 0` shape, and `submit_pvp_action`'s attack arm accepts a skill
for a fainted active. `pvp.rs` is **outside this slice's declared `touches:` path-set**
(`server-module/src/battle*.rs`, `server-module/src/battle_tests.rs`, `game-core/src/battle/*`),
so per the fan-out discipline it is a hidden dependency: recorded, not silently widened into.

The spec's EARS E1 says "for both PvE and PvP starts". **The PvP half is not delivered here.**
What ships is coherent on its own — in PvE a 0 HP monster is never seated as lead, never
resolves an attack, and a player facing a legacy row always has a working way out — and the
follow-up is a mechanical two-line adoption of the API this slice defines, with no design
decisions left in it.

PvP is **not made worse**: D3's rejection means no `game-core` behavior changed, so PvP
resolves exactly as it does on `master` today. It is, however, still exposed to a real
sac-lead exploit (a deliberately 0 HP lead deals full damage, absorbs the opponent's turn-1
attack, and buys a free switch that costs no turn). That raises the follow-up's priority.

### Residuals (named, not done)

- **P1 — `pvp.rs` adoption of D1 + D2.** Out of touch-set (D7). **Recommended as the immediate
  next slice**; ranked play is the higher-stakes surface.
- **P2 — `BattleSide.active` privatization.** Blocked by a mechanical gate, not preference:
  `evals/spacetime-type-snapshot.eval.mjs` regex-parses `pub <field>: <type>` and exact-matches
  against `evals/baselines/spacetime-types.json`, so dropping `pub` reads as a **wire-breaking
  field removal**. Needs a slice that also owns `evals/`. This supersedes ADR-0053 residual
  (a)'s weaker "wider touch-set" rationale. (`#[non_exhaustive]` on `BattleSide` was identified
  as a way to block out-of-crate struct-literal construction without tripping that eval; it
  requires converting ~16 `BattleSide { .. }` literals across `server-module` test files, which
  is outside this slice.)
- **P3 — one-time repair of legacy `battle` rows with a 0 HP active.** Deliberately not
  attempted. **Accepted risk:** such a row self-repairs in one player action (swap, recruit, or
  any enemy hit) and D2 blocks the misleading attack in the meantime.
- **P4 — `use_battle_item` on a fainted active** may waste one cure item. Out of EARS scope.
- **P5 — client attack-button gate.** `client/src/ui/battleModel.ts` builds `skills` with no
  `currentHp > 0` check, so on a legacy row D2 surfaces a reducer error where a button
  previously appeared to work. `canSwap`/`bench` already render the recovery affordance.
  `client/` is out of touch-set; adjacent to ADR-0155.
- **P6 — `BattleSide::has_conscious_member`** has no production callers once D1 lands (only
  test callers). Deleting a `pub` `game-core` method is an exported-symbol change and belongs
  in its own slice.
- **P7 — no reducer-executing test harness.** `server-module/src/battle_tests.rs` proves
  reducer behavior only by scanning `include_str!("battle.rs")`. Every server-side guard in
  this repo therefore rests on string assertions. An integration harness that can execute a
  reducer against a live `ReducerContext` would convert E2 and E3-layer-1 from structural to
  behavioral proofs. Out of touch-set; the largest standing gap in this subsystem's gate.

## Amendment to ADR-0155

ADR-0155's clearing argument states that "a fainted active never coexists with `Ongoing`". That
holds **mid-battle** — every faint site auto-switches or terminates — but **not at battle
construction**, which is the hole this ADR closes. ADR-0155's ux4 verdict (the swap UI was
correct; ship hints, not a fix) is unaffected: the swap path it cleared is the same path D6
now pins as the recovery route.

## Consequences

- Entry abilities now fire on the **real** lead, and the pre-fix behavior was *not* uniform:
  `apply_entry_ability`'s `EntryHeal` arm has a `!is_fainted()` guard so a corpse's heal was
  skipped, but the `StatusImmunity` arm has **no** such guard, so a corpse's immunity did fire.
  After this slice the correct monster's ability fires at turn 0 in both cases. This is the only
  observable behavior change besides `active` itself, and it is desirable. PvP is unaffected
  (`pvp.rs` still passes `active: 0`), so PvP entry-ability behavior is bit-identical to master.
- **`lead_party` and `with_lead` now mean different monsters, deliberately.** `lead_party`
  (`server-module/src/battle.rs`) returns the lowest-`party_slot` monster HP-blind, and its level
  feeds the wild encounter roll; `begin_encounter` then seats the first *conscious* monster. When
  slot 0 is fainted these are provably different monsters: the corpse steers the wild's level
  band, the survivor fights it. The scaling itself is pre-existing and unchanged, but the two
  functions now use "lead" for two different things in the same file — noted so a future reader
  does not "unify" them without deciding which rule encounter scaling should follow.
- Four `BattleSide { active: 0, .. }` literals in `battle.rs` become `with_lead` calls; the two
  in `pvp.rs` remain until P1.
- Server-side gating tests for this slice are **source-scan** assertions: `battle_tests.rs` is
  `include_str!`-based and there is no reducer-executing harness. The behavioral proof for D1
  lives in `game-core`. **Honest scope, measured rather than asserted:** an adversarial pass
  built a tree in which this defect was fully intact and every server-side scan still passed,
  via three evasions — a dead `let _ = …is_fainted();` binding, adopting `with_lead` and then
  writing `side_a.active = 0;` (legal because `active` is still `pub` — residual P2), and
  permuting `team` at the call site before passing it in. The scans were hardened against all
  three (block-scoped `return Err` + audit assertions, a forbidden-needle set covering
  `.active =` / `set_active(`, and argument pinning on `with_lead(team_a)`/`with_lead(team_b)`).
  What remains true: **the scans detect a fix that was never started or was locally undone;
  they cannot see through indirection into a differently-named helper.** The only complete
  mechanical proof would be an integration test that starts a battle from a 0 HP slot-0 party
  and reads back `battle.state.side_a.active`. That harness does not exist and is out of
  touch-set — recorded as residual P7.
- **The four `with_lead` call sites must stay inline** in `start_battle` / `begin_encounter`.
  The scans assert a per-body call count of exactly 2 and walk per-call-site windows for the
  audit assertion, so an otherwise-correct DRY `fn build_side(..)` helper would zero all of
  them. This is a deliberate, recorded trade: argument-level teeth (which catch the silent
  write-back corruption above) require call sites the scanner can see.

## EARS criteria → proof

| Criterion | Proof |
|---|---|
| E1 — battle start selects the first `hp > 0` monster as lead, never a 0 HP one | `with_lead` unit tests (exact indices, order preservation) + `battle.rs` construction scans. **PvE only — PvP parked (D7).** |
| E2 — an action for an already-0 HP active is rejected, not silently resolved | `submit_attack` guard + ordered source scan. PvE only (D7). |
| E3 — swapping INTO a 0 HP monster is rejected | Verified at two layers (D5); gating tests pin both. |
| E4 — double-KO / speed-tie 0 HP rule researched and documented | D4, with comparator evidence and citations. |
| E5 — regression test reproducing Drew's exact sequence | `battle_0hp_tests.rs`: 0 HP lead → the conscious monster is seated → a full turn resolves with **no** `Faint{SideA}` and **no** `Switch{SideA}` in the event stream. |
