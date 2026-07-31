# 0167 — PvP side-B battle overlay: role-agnostic accessors + a view-boundary perspective projection

**Status:** Accepted
**Date:** 2026-07-31
**Slice:** 11r-b
**Supersedes:** —
**Amends:** ADR-0042
**Subsystems:** battle, client-ui
**Decision:** The store's battle accessors match either PvP role and return RAW server rows; a pure `ownPerspective()` projection re-seats the local player as sideA and is applied at exactly ONE view call site, leaving diagnostics on server truth.

## Context

`store.ongoingBattle()` and `store.latestPlayerBattle()` filtered
`b.playerIdentity === identity` only. A PvP **accepter** is stored in
`opponent_identity` (`server-module/src/pvp.rs:289-297`), so side B matched
neither accessor and got **no battle overlay at all** in production builds — no
cards, no skills, no bench, no swap — frozen until the 60 s deadline reaper
(`pvp.rs:1124-1178`) forfeited them.

This was disclosed as a CRITICAL by ADR-0155 D6
(`M-postgate-pvp-side-b-overlay`) and left unfixed there because `main.ts` /
`store.ts` were outside that slice's touch-set. It survived a milestone of green
CI because the e2e suite drove side B through the **DEV-gated, role-agnostic**
`__mrPvp.battleById` hook (`main.ts:1807-1838`) instead of the production path:
the tests exercised a path production builds do not have.

Eight production call sites read those two accessors
(`main.ts:1115, 1262, 1505, 1550, 1655, 1855, 1992, 2003`). Every one of them was
effectively dead for side B: no overlay, no `battleStart`/`battleEnd`
observability events (ADR-0130), an empty `battleId` on every ranked-rating
delta, a null `ongoingBattleId` in the F9 bug bundle — for precisely the player
most likely to file a bug report — and a `pvpPendingSubmit` latch that could
never arm.

The constraint that shapes the fix: `buildBattleViewModel`
(`ui/battleModel.ts:239-271`) and `battleView.#renderOutcome`
(`ui/battleView.ts:430-435`) hardcode **sideA = the local player** — `playerCard`
from `sideA.team[sideA.active]`, `skills` and `bench` from sideA,
`'SideAWins' → "Victory!"`. Both files are outside this slice's declared
`touches:`.

## Considered alternatives

- **Thread a `selfSide: 'A' | 'B'` parameter through `buildBattleViewModel`.**
  Arguably the purer model — the view model would name the asymmetry instead of
  assuming it away. Rejected: `ui/battleModel.ts` is outside this slice's
  `touches:`, the signature has many callers, and it buys nothing this slice
  needs. Recorded here so a later slice can revisit it deliberately.
- **Project inside the accessors themselves.** Rejected: it turns the store from
  a mirror of server truth into an opinionated view layer and silently poisons
  all six diagnostic/observability call sites at once.
- **Leave the accessors alone; special-case side B in `refreshBattle`.**
  Rejected: it fixes one of the eight sites and leaves the other seven lying to
  their callers, which is how this defect stayed invisible in the first place.

## Decision outcome

**D1 — The accessors match either role and return RAW rows.** `ongoingBattle` and
`latestPlayerBattle` match `playerIdentity === identity || opponentIdentity ===
identity` through a shared private predicate (one condition, two accessors — they
cannot drift), and return the store's row unchanged. The store stays a mirror of
server truth. Both take an explicit `identity === ''` early return: widening the
match from one participant column to two turns "no match" into "possible false
match" for a pre-join empty identity, and one line makes that impossible.

**D2 — A pure `ownPerspective(battle, identity)` projection, applied at exactly one
call site.** It returns the argument **by reference** when the local identity is
`playerIdentity` — an ordering that is load-bearing, because it also covers
practice battles, where `playerIdentity === opponentIdentity` (ADR-0109) and a
naive opponent-first check would seat the player on the wrong side of their own
mirror — and when the identity is in neither role. Otherwise it exchanges
`sideA`/`sideB`, `playerIdentity`/`opponentIdentity` and
`partyMonsterIds`/`opponentMonsterIds`, and permutes `outcome`
`SideAWins`↔`SideBWins`. `battleId`, `turnNumber`, `weather`, `createdAtMs`,
`'Ongoing'`, `'Fled'` and any unrecognized outcome string pass through verbatim —
the last of these deliberately, so `parseOutcomeTag`'s bindings-regen drift
detector (`ui/battleModel.ts:203-213`) still fires on a new server variant.

All six swapped fields are load-bearing, not symmetry for its own sake:
`partyMonsterIds`/`opponentMonsterIds` feed `isWild`
(`ui/battleModel.ts:275`) and therefore `canRecruit`, so swapping the sides
without swapping the id lists would classify a side-B PvP battle by the wrong
party.

The projection is applied at the `latest` binding in `refreshBattle`
(`main.ts:1262`), **not** at the `buildBattleViewModel` call. That placement also
fixes the PvP opponent-name lookup at `main.ts:1309-1313`, which reads
`opponentIdentity` off the row: on a raw side-B row that column *is* side B, so
the accepter would have seen their own display name painted on the opponent card.
One wrapped binding, two defects closed.

**D3 — Diagnostics stay RAW.** The event ring, the F9 key-store bundle, and the
`__game` / `__mrPvp` hooks all report the unprojected server row. Two players'
bug bundles must agree on who won; a perspective-mapped outcome in a bug report
would make them contradict each other. The cost is that side B's event ring
records `SideAWins` for a loss — server-side tags, where SideA is always the
challenger. That is written down at the emit site (`main.ts:1522-1524`), because
it reads like a bug to anyone who has not read this ADR.

**D4 — Forfeit is explicitly NOT in this slice.** The spec bullet says "wire the
overlay + forfeit for side B", but ADR-0155 D6's own finding is "no forfeit
control **anywhere**" — a both-sides gap, not a side-B parity gap. No
client-callable forfeit reducer exists (full reducer list checked); `flee` is
rejected server-side in PvP and is not even rendered (`canFlee: ongoing &&
!isPvp`). Forfeit today happens only via `forfeit_on_disconnect` and the deadline
reaper. After this slice **side B has exactly what side A has**, which is the
parity defect closed. Building a forfeit control for side B alone would be new,
asymmetric game-design surface — which this milestone's §4 scoping note
explicitly reserves for a Drew decision. Follow-up `M-pvp-forfeit-control` needs
`server-module/src/pvp.rs` (a new reducer plus its turn-deadline interaction),
`client/src/ui/battleView.ts` (button + confirm) and `client/src/main.ts` — two
of three outside this boundary — plus a ranked-rating question (does a manual
forfeit apply the same Elo as a disconnect forfeit?) that deserves its own ADR.

**D5 — The `battleById` DEV hook is retained, and the anti-slide guard is a test,
not a deletion.** The hook legitimately reads *both* sides by id, which the
production path never will, and `pvp-full.spec.ts` depends on it. Deleting it
would cost 780 lines of rework for zero product value. What must not recur is a
side-B assertion sliding back onto it, and that is enforced by the new e2e's own
call-counting guard (below).

## Enforcement, and one accepted residual

The primary anti-regression teeth are behavioral: `store.test.ts` fixtures where
the local identity is `opponentIdentity` (a revert to the old filter turns both
accessors `undefined` and both fail on the same line), and a production-path e2e
that drives side B through real DOM only.

Two teeth are shaped as **enumerated ceilings**, not substring bans, because this
repo has a measured case of the latter losing: a whole-file ban on `x?.hide` was
beaten CI-green by `const h = dialogueView; h?.hide();`
(`main.wiring.test.ts:4240-4279`). A bare needle on `ownPerspective` is defeated
the same way, by `import { ownPerspective as op }` or by computing the projection
into an unused binding and rendering the raw row anyway — the exact half-fix that
would show side B the **opponent's** cards, which is worse than the blank screen
it replaces. The ceiling pins the unaliased import form and caps whole-file
occurrences, so an alias, a second call, and a leak into the diagnostic regions
each fail the same assertion.

The e2e's anti-slide guard is likewise behavioral rather than lexical: a source
scan for `__mrPvp` is defeated by `window['__mr'+'Pvp']`, so `pvp-side-b.spec.ts`
installs a call counter over the hook before the app script runs and asserts it is
never invoked.

**Accepted residual:** a future author could hand-inline the side swap
(`{ ...raw, sideA: raw.sideB, ... }`) inside a diagnostic region and violate D3
without the identifier `ownPerspective` appearing anywhere. Closing that
mechanically needs a shape-matcher fragile enough to cost more than it catches;
it is left to code review and recorded here so the next reader knows it was
considered, not missed.

## Consequences

- Side B gets the real overlay: own cards, own skills, own bench, working swap,
  and a correctly-labelled Victory/Defeat frame.
- Seven previously-dead call sites become live for side B, each a strict
  improvement — the accessor stopped lying rather than the callers changing.
- ADR-0155 D6's note that "KeyB works mid-PvP for side B" becomes **false**: side
  B now has a visible battle overlay, so the same input suppression applies to
  both roles. That was always a side-A-only statement.
- These claims about the old one-sided filter are now stale and sit **outside**
  this slice's boundary, so they were recorded rather than edited:
  `client/src/net/connection.ts:558`, `client/src/ui/battleView.test.ts:2201-2204`,
  `docs/adr/0151-*.md:116`, `docs/specs/ux1-plan.md:93`.
- ADR-0155 D6 is closed by this ADR; the reciprocal `Amended-by` back-link on
  0155 is left to the supervisor's doc reconciliation (`docs/adr/**` beyond the
  reserved number is outside this slice's touch-set — the same convention 11r-d
  followed for ADR-0142).
