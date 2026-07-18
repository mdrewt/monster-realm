# 0125 — Leaderboard profile.name passive mirror on rating application

**Status:** Accepted
**Date:** 2026-07-18
**Slice:** m17.5d
**Supersedes:** —
**Amends:** ADR-0119
**Subsystems:** battle
**Decision:** Refresh `profile.name` from the live `player` row (when present) inside `get_or_init_profile`'s `Some` arm — in-memory only, no extra write — so `apply_pvp_rating`'s existing `..winner`/`..loser` spreads persist the current name on every rated game.

## Context

ADR-0119 seeded `profile.name` once, in `get_or_init_profile`'s insert arm, from the `player`
presence row. `apply_pvp_rating` updates rows via `Profile { rating, .., ..winner }` spreads that
carry the old name forward, and no other path writes `profile.name`. Because `join_game`
(movement.rs) recreates the `player` row with a fresh `validate_name`'d name every session (and
`on_disconnect` deletes it), any rename left the public leaderboard permanently showing the
player's first-ever rated name (M17.5 §17.5d, tenth-review finding; EARS 17.5d-1/-2).

## Decisions

### D1 — Passive mirror at the profile-read seam, not a name-edit reducer

`get_or_init_profile`'s `Some` arm now returns
`refresh_profile_name(existing, live_player_name(ctx, identity))`: a pure, ctx-free
`refresh_profile_name(profile, live_name)` that replaces `name` when `live_name` is `Some` and
keeps the existing name on `None` (player row absent — e.g. rating applied after a
disconnect-forfeit, where `on_disconnect` already deleted the row). The refresh is **in-memory
only**: no write happens in `get_or_init_profile`, preserving its write-count shape (find-or-insert,
never update). Persistence rides the two existing `apply_pvp_rating` update spreads, so BOTH
winner and loser names refresh on every rated write and the compute-before-write ordering
(ADR-0119 D6/F9) is untouched.

A client-callable `set_profile_name` reducer was deliberately NOT added: that is the parked
D-17.5-C decision, and ranking.rs is module-write-only (ADR-0119 D6 — no reducer may live there;
the RL-7 scan enforces it). The mirror gives rename-follows-presence for free; the accepted cost
is that a rename surfaces on the **next rated game**, not instantly (leaderboard staleness of at
most one game).

### D2 — No empty-string special-casing in the refresh

`refresh_profile_name` does not filter empty names: `validate_name` (guards.rs) rejects empty at
the only `player.name` write boundary (`join_game`), so a live name is always non-empty by
invariant. Re-validating here would duplicate the boundary rule (parse-don't-validate: the
`player` row is already-parsed data). The `None`-arm insert keeps its `unwrap_or_default()`
fallback — a defensive empty only reachable if rating is applied with no player row and no prior
profile, which the decisive-path ordering already prevents (ADR-0119).

### D3 — Shared lookup helper

Both arms read the live name through one private helper,
`live_player_name(ctx, identity) = ctx.db.player().identity().find(identity).map(|p| p.name)`.
The inline chained `.map` form is load-bearing twice over: it is None-safe when the player row is
absent (a simultaneous-disconnect race can settle a rating after BOTH rows are gone — an `.unwrap()`
form would panic there), and it avoids the `= ctx.db.<table>()` split-binding shape. For the
`profile` table that shape is a safety invariant (RL-2 never-deleted evasion heuristic); for the
`player` table it is a style convention kept for uniformity. The helper's exact body, its use by
both arms, and the absence of split-bindings in ranking.rs are pinned by this slice's
ranking_tests.rs source-scans (the pre-existing repo-wide scans deliberately exclude ranking.rs
internals). One lookup shape, two call sites, zero drift.

### D4 — No new attack surface (red-team confirmed)

The mirror propagates only data that is already validated and already public: `player.name` passes
`validate_name` (trim + NFC, non-empty, ≤ 24 chars, alphanumeric/space allowlist — no markup, bidi,
or zero-width injection) at its single write boundary, and the `player` row is world-readable
today. Name non-uniqueness (two players choosing the same display name) and per-rated-game name
churn were both already possible under first-write-wins seeding; the mirror changes neither.

## Consequences

- A rename now surfaces on the next rated game for both participants; historical stale names
  self-heal as players play.
- `get_or_init_profile`'s `Some` arm is no longer a pure passthrough — callers observing the
  returned `Profile` see the live name, which is the desired read semantics for any future caller.
- The pure core is unit-tested executed (ranking_tests.rs d1_*/d2_*); the ctx wiring is pinned by
  a composed-call source-scan needle. All eight pre-existing RL-5/RL-7/RT-M17-01 byte-pins over
  ranking.rs survive unchanged.
- If a `set_profile_name` slice is ever scheduled (D-17.5-C), it composes cleanly: an explicit
  write there and this passive mirror agree because both source from the same `player.name`
  boundary invariant.
