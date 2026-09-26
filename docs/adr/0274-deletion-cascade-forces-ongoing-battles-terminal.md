# ADR-0274 — The deletion cascade forces a still-`Ongoing` battle terminal against the erased side before tombstoning it; ADR-0228 D2's `Ongoing` skip is retired (rb-129)

**Status:** Proposed
**Date:** 2026-09-26
**Slice:** rb-129 (closes residual R-rb-45-ONGOING-BATTLE, promoted from source slice rb-45; M-residual-backlog.spec.md#rb-129)
**Supersedes:** —
**Amends:** ADR-0228, ADR-0119, ADR-0229
**Extends:** 0258, 0138, 0109
**Subsystems:** security-authz, battle
**Decision:** anonymize_battles forces every still-Ongoing row naming the erased identity terminal through the pure battle_with_forced_terminal seam (PvP: game-core forfeit against the erased side; wild: Fled) before the tombstone swap; no skip remains.

---

> DRAFT SKELETON — planning-phase checkpoint. The doc-keeper finalises this file after the
> implementation lands (line citations, measured RED/green counts, mutant kills).

## Context and problem statement

M22 §4.4's deletion cascade (`accounts::account_deletion_reaper`, ADR-0228) resolves every live
interaction first (step 6a, `resolve_all_live_interactions`), erases per module (6b), then
anonymises the deleted player's `battle` rows (6c, `battle::anonymize_battles`) before stamping the
terminal marker. ADR-0228 D2 / RT-11 deliberately SKIPPED an `Ongoing` row at 6c: such a row means
6a's `pvp::forfeit_on_disconnect` failed on it (its `apply_pvp_forfeit` Err arm is log-and-continue),
and sweeping the row's live `pvp_deadline_schedule` entry would have removed the only mechanism by
which the surviving opponent could still win by timeout.

The rb-45 security audit (ADR-0258 D6 class (i)) registered that skip as residual
R-rb-45-ONGOING-BATTLE rather than a claim of safety: the skipped row survives the cascade still
naming the erased identity and still `Ongoing`, and two post-terminal channels then exist —
(a) `submit_pvp_action` is not deletion-gated (PRV1-10 keeps open commitments completable), so the
erased identity can settle the battle later and reach `economy::grant_currency`'s insert-if-absent
arm and `evolution::check_and_evolve`, re-minting rows for an erased account; (b) the deadline reaper
kept alive by the skip settles the battle through the full funnel — with the erased side's
`battle_action` rows already deleted by 6b, an unpicked side-A survivor forfeits, the ERASED identity
wins, and `ranking::apply_pvp_rating` re-mints its profile row.

`settle_pvp_battle` is infallible today (both fallible steps inside it are log-and-continue), so the
Err arm is currently unreachable. The hole is latent: a future `?` in the funnel reopens it, and
nothing mechanical guards it.

## Decision

1. **D1 — a pure seam decides the terminal outcome.** `battle::battle_with_forced_terminal(b, deleting)`
   rewrites ONLY `state.outcome`, and only when the row is `Ongoing`: a wild row (the ADR-0138 D1
   predicate `is_ongoing_wild_battle`, checked first) becomes `Fled` (ADR-0138 D2 auto-flee parity);
   a PvP row becomes `game_core::pvp_forfeit_outcome(<side of the erased identity>)` — the side-A pass
   first, so a practice battle (both sides the erased identity) resolves as side A forfeiting, the
   ADR-0109 D8 order `forfeit_on_disconnect` itself uses; a row not naming `deleting` is unchanged.
   Settled history is never rewritten. Postcondition (debug-only): a row naming `deleting` never
   leaves the seam `Ongoing`.
2. **D2 — the shell is branch-free except for observability.** `anonymize_battles` sweeps the row's
   join-only children first (unchanged), forces the row through D1 BEFORE the tombstone swap (the
   seam needs the original identities), emits ONE `observability::mr_log`
   (`deletion_cascade_forced_battle_terminal`, `battle_id` only) when the outcome changed — a forced
   row is an anomaly the cascade must not swallow silently — and performs the single PK-keyed update
   through `battle_with_tombstoned_party` exactly as before. No `continue`, no collect-side filter.
3. **D3 — ADR-0228 D2's skip is retired, and the RT-11 rationale falls away with it.** The survivor
   no longer needs the deadline: they receive the decisive win immediately, in the same transaction.
   The recorded asymmetry about the erased side's deleted `battle_action` rows is moot.
4. **D4 — step 6a is unchanged; the backstop lives at 6c.** Only 6c sees every row naming the owner
   after all erasures, so it is the one place a mechanical "no Ongoing row survives the cascade"
   guarantee can be stated. `pvp::forfeit_on_disconnect` keeps its log-and-continue arm (on a plain
   disconnect the armed deadline still settles the battle later); its docs now say so.
5. **D5 — proof per ADR-0224.** Ordinary Rust `#[test]`s: a truth table and a shape-varied totality
   matrix over the pure seam, a seam-body pin that the forfeit rule comes from game-core, an exact
   squashed-body pin of `anonymize_battles` (the native host cannot execute it), and the re-derived
   `m22s3b` pin (absence of the skip). No new eval.

## Considered alternatives

- Retry the full settle at 6c — rejected: re-enters the funnel that just failed, now against erased
  or anonymised rows (rating, `grant_currency`, `check_and_evolve`) — the re-mint class being closed.
- Abort the cascade (Err/panic) on a surviving Ongoing row — rejected: the runtime deletes the fired
  one-shot schedule row, so the account would stay un-reaped; a persistent settle error would make
  it undeletable (ADR-0228 D1 keeps the erase helpers infallible).
- Delete the row — rejected: `battle` is manifest-classified ANONYMIZE, the survivor's record must
  persist, and the m22s3b census pins zero `battle` deletes.
- Force inside `forfeit_on_disconnect`'s Err arm — rejected: a second terminal-commit site on the
  ordinary disconnect path, unreachable by the native host, missing rows 6a never selected.
- Gate `submit_pvp_action` with `require_not_deleting` — rejected: contradicts PRV1-10 / ADR-0227 D5
  and leaves the survivor's row Ongoing anyway.
- Tombstone but keep Ongoing and let the deadline settle it — rejected: a live deadline against an
  erased participant, and rating against the tombstone identity.
- Fold the force into `battle_with_tombstoned_party` — rejected: breaks its every-field-survives
  contract and its truth table.
- `Fled` for PvP rows — rejected: the client would show the survivor "you fled".

## Consequences

- (to be completed by the doc-keeper from the shipped diff: measured RED counts, mutants killed,
  degraded-settlement statement, `is_ranked_pvp` classification note, spec §3 deviation for Ongoing
  rows only, no-backfill argument, load-bearing sibling gates rb81 P1/P4 / rb45 census / accounts X5,
  the owner-equals-WILD degenerate input, the registered residual R-rb-129-X5-PROSE.)
