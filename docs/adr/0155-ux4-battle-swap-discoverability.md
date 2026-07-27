# 0155 — ux4 battle-swap discoverability: the swap UI was correct, so explain the absence instead of fixing it

**Status:** Accepted
**Date:** 2026-07-25
**Slice:** ux4 (M-postgate-ux-hardening — repro-and-confirm the battle monster-switch gap, then hint; EARS ux4-1..ux4-3)
**Supersedes:** —
**Amends:** —
**Amended-by:** ADR-0156
**Subsystems:** client-ui, battle
**Decision:** ux4-1 confirmed the box/team-separation hypothesis and refuted a swap-UI bug, so ship no fix — pin the working PvE swap path with teeth and add two persistent hints that explain the absence without advertising a currently-dead key.

## Context

Drew's 2026-07-25 playtest reported "no method of switching monsters seemed to exist." The
spec (`M-postgate-ux-hardening` § ux4) deliberately ordered a repro-and-confirm step before
any fix, because reading the code suggested the swap UI already existed. ux4-1 is that step;
ux4-2 (explain the absence) and ux4-3 (fix the swap UI) were written as mutually exclusive
branches off its verdict.

## Decision

### 1. ux4-1: hypothesis CONFIRMED, swap UI REFUTED as the defect ⇒ ux4-2 applies, ux4-3 does not

The chain, verified at `4368a07`:

- `server-module/src/taming.rs:163` — a successful recruit inserts
  `monster_from_instance(me, &inst, PARTY_SLOT_NONE)`, so the new monster lands in the **box**.
  This is a *decided* behaviour, not an accident: ADR-0047 §3 chose box placement to avoid
  clobbering an occupied party slot.
- `server-module/src/battle.rs:283-294` (`lead_party`) builds side A from
  `.filter(|m| m.party_slot != PARTY_SLOT_NONE)`, so a boxed monster can never enter `sideA.team`.
- `client/src/ui/battleModel.ts:257-271,316` — `bench` is the non-active, non-fainted subset of
  `sideA.team` (computed only when `ongoing`), and `canSwap = bench.length > 0`.
- `client/src/ui/battleView.ts:259-261,371-391` renders one `Swap: <name> (hp/max)` button per
  bench member. Correct.

So with a single party monster the bench is empty and `canSwap` is **correctly** `false`. The
real gap is that "how do I move a recruit into my party" is an undiscovered mechanic, not a
broken control.

A red-team pass built the repro as **executable probes** (S1/S2/X2) rather than as prose, and
measured all three GREEN on the untouched tree — that is the discharge of ux4-1. The same pass
cleared every alternative failure mode that could have made the report true anyway:
`battleVMsEqual` compares `canSwap` and every bench field including `teamIndex`, so no
swap-relevant transition is suppressed; the `<select>` save/restore nulls its handle *after*
the save; `sideA.active` is bounds-guarded and the server auto-switches on faint, so a fainted
active never coexists with `Ongoing`; `rowConvert.ts` maps `sideA.team` 1:1 with no reorder;
and `swap_active`'s three reject paths are all excluded by the client's own bench filter — so
**a rendered swap button cannot dispatch a rejected reducer.**

Two coverage facts make S1/S2 load-bearing rather than ceremonial: the existing suite pinned
only `Submit Swap:` (PvP), so **S1/S2 are the first PvE `Swap:` assertions in the repo**, and
there is no TS mutation harness (cargo-mutants is Rust-only), so deleting the PvE arm of the
label ternary was a **green mutant** before this slice.

### 2. Explain the absence in the battle shell; state the rule in the box shell

Two persistent hints, one per shell, each honest about what the player can do *from where they
are standing*. `battleView`'s hint is toggled (it asserts a conditional fact); `boxView`'s is
static (it asserts a model invariant). COPY B alone cannot reach a player who never opens the
box — and the belief this slice exists to correct forms *in the battle screen*, where `?` is
also a dead key (ADR-0151 residual #2), so today there is no affordance on screen at all.

The battle hint is toggled inline at the end of `#renderActions`, immediately after the
`if (vm.canSwap) { this.#renderSwapButtons(vm); }` branch, on
`vm.outcome === 'Ongoing' && !vm.canSwap`. The predicate keys on **`!vm.canSwap`, not
`bench.length === 0`**, so "hint shown ⟺ no swap buttons rendered" is structural — same flag,
same method — instead of derived through the model's `canSwap = bench.length > 0` identity.
*Correcting this ADR's own planning rationale:* the inconsistent shape `canSwap:true, bench:[]`
was **measured to behave identically under both predicates** (neither renders buttons, neither
shows the hint), so it is not the argument. The only separating shape is `canSwap:false` with a
non-empty bench, where a bench-based predicate would hide the hint while rendering no buttons —
the exact silent dead-end this slice removes. That shape is pinned by H8.

### 3. The honesty constraints are load-bearing, not stylistic

Each of the following was measured against live code, and each one is a tooth rather than a
comment. The immediately preceding slice (ux1/ADR-0151) shipped a badge advertising an overlay
that did not render; repeating that failure mode in the very next slice is the worst available
outcome.

- **`B` is dead while the battle overlay is open.** `main.ts`'s KeyB branch gates on
  `shouldToggleBox(battleView?.visible ?? false)` and `client/src/inputGuards.ts` is
  `return !battleVisible`.
- **It stays dead for the whole battle, and past its end.** Escape on an *ongoing* battle is a
  bare `hide()` whose next batch re-shows the overlay; and a terminal battle row is not GC'd on
  resolution (`battle.rs` deletes only *prior* terminals) while `decideBattleOverlay` re-shows a
  non-dismissed terminal. So after victory/defeat/flee the overlay persists and B stays dead
  **until Escape** — which is why the copy names the Esc step and puts the timing qualifier
  *before* the key name.
- **The copy does not advertise healing.** `heal_party` is zone-gated (`raising.rs:302-304`; the
  only heal location is `zone_id: 0` while a zone-1 encounter table exists), and `main.ts` skips
  the send entirely when no heal location is in the store.
- **The battle copy is scoped "in this battle".** This is not hedging; it is a red-team-proven
  falsifiability sequence: Escape un-gates KeyB → `set_party_slot` has **no in-battle guard** →
  `To Party` is accepted → that row write re-shows the overlay → but `sideA.team` is a *snapshot*,
  so `canSwap` stays false while an unscoped copy would claim no monster is available when one
  demonstrably is. The scoping is the honesty property, and a future copy edit must preserve it.
- **The box copy is state-neutral.** It *describes* the `To Party` button instead of commanding a
  click, because the empty-box branch (`boxView.ts:118-124`) renders no such button — and the
  fresh-player state (`movement.rs` grants exactly one monster, empty box) is precisely the state
  a confused new player is in.
- **The toggled-vs-static asymmetry is structurally forced, not a style call.**
  `BattleView.refresh` has `outcome`/`canSwap` in hand and the battle copy is *false* whenever
  `canSwap` is true, so it must be toggled and reset. `BoxView.refresh` has no nullable argument
  and no terminal state, and the box copy asserts a model invariant that is true whenever the
  overlay is open — a toggled box hint would require *inventing* a predicate.

The `refresh(null)` reset line is symmetry/defense, not the production defense:
`refresh(null)` is reachable in production only on the corrupt-VM path, since `main.ts` dismisses
with a bare `hide()`. The live defense is the `'none'` arm of the toggle.

### 4. ux4-2 is discharged in a weakened, always-on form — not recruit-triggered

ADR-0047 §1 records that the client cannot distinguish a recruit-end from a knock-out end by
`outcome` alone, and already defers a first-class recruit event to the M14 event log. A
recruit-*triggered* hint therefore needs `main.ts`/`battleModel.ts`, both outside this slice's
touch-set, and anything less would be inference-based guessing. Stated plainly here rather than
claiming a trigger the implementation does not have.

### 5. The teeth are the only defense, so they are named for the mutants they kill

Both `client/src/ui/battleView.ts` and `client/src/ui/boxView.ts` are in `vite.config.ts`
`coverage.exclude` (sanctioned DOM shells, exact-set-guarded by
`evals/dom-shell-coverage-exclusion.eval.mjs`), and there is no TS mutation gate — so the hint
logic is neither coverage-measured nor mutation-probed by CI. **15 cases** across the two sibling
test files are the entire gate: S1/S2 (ux4-1 repro/refutation), H1-H8 in `battleView.test.ts`,
X2-X6 in the new `boxView.test.ts`.

The adversarial history is recorded because each correction generalises:

- An earlier, weaker version of this suite let a **cheating implementation** through: a show-only
  toggle with the reset laundered into `hide()`. It passed all 12 cases then written — including
  both arms of the reset case, since `refresh(null)` itself calls `hide()` and the dismiss path
  *is* `hide()` — while measurably parking the hint next to "Victory!" and beside a live `Swap:`
  button. **H7 exists solely to kill it**: live-view transitions with no `hide()` and no
  `refresh(null)`.
- Three conjunct mutants (`weather === null`, `playerCard.status === null`,
  `cureItems.length === 0`) survived until the H1 fixture varied those fields. Generalising:
  a conjunct over any field that is *constant across every fixture* is invisible to the suite.
- A copy carrying `' Or press ? for help.'` survived at 124 chars until `?`/`help` fences and a
  120-char cap landed — `?` is also dead behind the battle overlay, so that addition would have
  re-shipped the literal ux1 lie.
- A whole-sentence-swapped copy survived until a **reason-before-remedy** ordering assertion
  landed, which is a different property from H1d's timing-before-key ordering *within* the remedy.

Final probe: **26/26 named mutants killed.**

## Consequences

### Deferred — named, with the evidence

- **D1 `M-postgate-recruit-box-server-pin`** — nothing pins `attempt_recruit` granting
  `PARTY_SLOT_NONE` (`taming.rs:163`) or the `lead_party` filter (`battle.rs:288`);
  `taming_tests.rs` has zero `party_slot` hits. Do **not** overclaim "the server half is
  unpinned": `guards_tests.rs` already pins `check_monster_in_party(PARTY_SLOT_NONE).is_err()`.
  `server-module/**` is outside this slice's touch-set.
- **D2 `client/e2e/swap-hint.spec.ts`** — happy-dom performs no layout, so every case here proves
  *present + not `display:none`*, **never** *visible* (ADR-0151 D5). Both shells build real
  `position:fixed;inset:0` roots, so the ux1 below-the-fold defect does not apply — but that is a
  source read, not a test claim. **Locator note for whoever writes that spec:** `To Party` now
  matches **two** nodes (the hint div and the real button), so it must use
  `getByRole('button', { name: 'To Party' })` or it is a Playwright strict-mode violation.
- **D3 party-full `To Party` is a silent no-op** — `main.ts` maps boxView's `-1` sentinel to
  `nextFreePartySlot(...) ?? PARTY_SLOT_NONE`, so with a full party it sends 255 and the monster
  silently stays in the box. A real dead-end; `main.ts` is forbidden here. The box copy's "an
  **open** party slot" is the hedge, pinned by X3.
- **D4 auto-add recruits to the party** — explicitly out per spec §3 (a game-design call).
- **D5 first-class recruit-success event/toast** — blocked by ADR-0047 §1, already deferred there
  to the M14 event log.
- **D6 `M-postgate-pvp-side-b-overlay` — CRITICAL pre-existing product bug, found by this slice.**
  The PvP **side-B** player never gets a battle overlay at all: `refreshBattle` reads
  `store.latestPlayerBattle(identity)`, which skips rows where `playerIdentity !== identity`, and
  the accepting player is stored as `opponent_identity` (`pvp.rs:291`). The codebase already
  documents the workaround on the **debug surface only**, and `client/e2e/pvp-full.spec.ts`
  bypasses the UI for side B. Consequences: no cards, no skills, no swap buttons for the
  challenged player, **no forfeit control anywhere** (zero `forfeit` hits in
  `pvpView.ts`/`pvpModel.ts`), frozen until the 60 s turn deadline. Two consequences for ux4: the
  battle hint is **side-A-only in PvP**, and because `battleView.visible` is false for side B,
  KeyB *does* work mid-PvP for them — so "B is dead while the overlay is open" is a **side-A
  statement**. Not fixed here (`main.ts`/`store.ts` outside the touch-set); this is the biggest
  thing the slice found and did not fix.
- **D7 `set_party_slot` has no `is_in_ongoing_battle` guard** (`monster_mgmt.rs`), unlike
  care/train/heal_party (ADR-0122/0136). The domain audit traced it and found it **not
  exploitable**: `write_back_party_hp` pairs `side_a.team` positionally with the battle's
  `party_monster_ids` **id snapshot** and never reads `party_slot`; all nine server-side
  `party_slot` readers are at battle-start or unrelated (no mid-battle reader exists);
  `challenge_pvp`→`accept_challenge` re-validates via `build_pvp_team`; the trade-escrow guards
  match ids, not slots; and `check_party_slot` caps the party at 6. But the safety is **emergent,
  not guarded, and untested** — there is no `monster_mgmt_tests.rs` at all — so it becomes live
  the moment any feature recomputes side A from `party_slot` mid-battle. Low urgency, real
  deferral. It is also the mechanism behind the battle copy's "in this battle" scoping (§3).
- **D8 (cosmetic residual)** party slot labels are 0-indexed (`Slot 0`..`Slot 5`) — a
  least-surprise wart the box copy's "an open party slot" brushes against.

### Disclosed residuals and accepted trade-offs

1. **The hint fires most often in exactly the state where the Recruit control is on screen** — a
   wild battle with one party monster renders `recruit-action` in the same `#actionsEl`. The copy
   does not mention Recruit; naming it would need a `canRecruit` branch, rejected on the ADR-0151
   D3 no-special-case precedent. An explicit trade-off, not an oversight.
2. **PvP with `pvpPendingSubmit === true` and a non-empty bench:** swap buttons are suppressed
   while the hint stays hidden (`canSwap` is true). No lie is told — the pvp-status banner
   explains the wait — so this is disclosed rather than changed.
3. **A layout risk this slice cannot settle.** `battleView`'s root is `justify-content:center`
   with **no** `overflow` (unlike `boxView`'s `overflow-y:auto`), so ~20 px of added height pushes
   ~10 px off each end if the overlay's content already approaches viewport height. happy-dom does
   no layout and this is not decidable from source — flagged for a 720p measurement, folding into
   D2.
4. **The copy hardcodes `Esc` and `B`.** The existing `W-HELP-FANOUT-OPENGUARDS` /
   `W-OVERLAY-FANOUT-MUTEX` source-scan teeth pin the KeyB handler's guard *shape*, not the
   letter, and nothing pins `boxView?.toggle()` as KeyB's *effect* — so a rebind would make both
   hints lie silently.
5. **"Press Esc, then B" can need a second Esc.** After the battle dismiss, KeyB additionally
   requires dialogue/questLog/heal/shop/trade/pvp to be hidden, and the battle auto-show does
   **not** hide those — so behind one of them the player needs another Escape first.
6. **The box copy is reachable mid-battle for PvP side B** (via D6), where "only party monsters
   can battle" is true but joining the party mid-battle will not enter the live battle.
7. `client/e2e/recruit.spec.ts` carries pre-existing line citations into both shells that this
   slice's insertions shifted; `client/e2e/**` is outside the touch-set, so they were not
   re-anchored.
8. Two stale citations remain in the pre-ux4 ux1-2 region of `battleView.test.ts`
   (`battleView.ts:401` → now `:421`), deliberately left alone to keep this diff out of the ux1
   test region.
