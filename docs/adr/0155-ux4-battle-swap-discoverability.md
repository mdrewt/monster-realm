# 0155 — ux4 battle-swap discoverability: the swap UI was correct, so explain the absence instead of fixing it

**Status:** Proposed
**Date:** 2026-07-26
**Slice:** ux4 (M-postgate-ux-hardening — repro-and-confirm the battle monster-switch gap, then hint; EARS ux4-1..ux4-3)
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui, battle
**Decision:** ux4-1 confirmed the box/team-separation hypothesis and refuted a swap-UI bug, so ship no fix — pin the working PvE swap path with teeth and add two persistent hints that explain the absence without advertising a currently-dead key.

## Context

*(draft — planning checkpoint; finalized by the doc-keeper pass at slice close)*

Drew's 2026-07-25 playtest reported "no method of switching monsters seemed to exist." The
spec (`M-postgate-ux-hardening` § ux4) deliberately ordered a repro-and-confirm step before
any fix, because reading the code suggested the swap UI already existed.

## Decision

**1. ux4-1: hypothesis CONFIRMED, swap UI REFUTED as the defect ⇒ ux4-2 applies, ux4-3 does not.**
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
real gap is that "how do I move a recruit into my party" is an undiscovered mechanic.

**2. Explain the absence in the battle shell; state the rule in the box shell.**
Two persistent hints, one per shell, each honest about what the player can do *from where they
are standing*. `battleView`'s hint is toggled (it asserts a conditional fact); `boxView`'s is
static (it asserts a model invariant).

**3. The honesty constraints are load-bearing, not stylistic.**
`B` is a dead key while the battle overlay is open (`main.ts:551-577` →
`client/src/inputGuards.ts:6-8`), and the overlay persists after a terminal outcome until
Escape (`server-module/src/battle.rs:1013-1022` keeps the latest terminal row;
`battleModel.ts:379-386` re-shows it), so the battle-screen copy names the Escape step and
puts the timing qualifier *before* the key name. `heal_party` is zone-gated
(`server-module/src/raising.rs:302-304`), so the copy does not advertise healing. The box
copy is state-neutral because `boxView.ts:118-124` renders no `To Party` button when the box
is empty — the fresh-player state. Each of these is a tooth, not a comment: the
immediately-preceding slice (ux1/ADR-0151) shipped a badge advertising an overlay that did not
render, and repeating that failure mode is the worst available outcome.

**4. ux4-2 is discharged in a weakened, always-on form.** ADR-0047 §1 records that the client
cannot distinguish a recruit-end from a knock-out end by `outcome` alone, and defers a
first-class recruit event to the M14 event log — so a recruit-*triggered* hint is not available
without `main.ts`/`battleModel.ts`, both outside this slice's touch-set.

## Consequences

*(draft — deferrals D1-D8, disclosed residuals, and the gate inventory are written at slice close)*
