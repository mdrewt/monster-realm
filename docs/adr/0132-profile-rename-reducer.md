# ADR-0132 — `set_profile_name` rename reducer + RL-7 module-write-only tooth refinement

**Status:** Accepted
**Date:** 2026-07-19
**Slice:** pt-c1
**Supersedes:** —
**Amends:** ADR-0119
**Subsystems:** security-authz, ci-gates

**Decision:** `set_profile_name` in `ranking.rs` validates via `validate_name` and writes only `player.name` (Option a); the ADR-0125 mirror surfaces it on the leaderboard, and RL-7 refines from zero reducers to one profile-untouching name-setter.

---

## Context

D-17.5-C (playtest-replan §3, `M17.5-tenth-review-residuals.spec.md` §3) scheduled the missing
server-side `set_profile_name` write path: m17b's leaderboard UI referenced a reducer that did not
exist, so players could not rename (H2 attachment gap). This slice (pt-c1) ships the server half;
the client rename UI is parked to **pt-c1b** (it cannot live in `client/src/ui/leaderboard*`, whose
RL-15 source-scans forbid the write path, so it needs `main.ts`/`index.html` — a separate serial slice).

`ranking.rs` was deliberately **reducer-free**: the `profile` table is module-write-only (ADR-0119 D6),
with `rating`/`wins`/`losses` mutated only via `apply_pvp_rating` from the `settle_pvp_battle` funnel.
The display-name SSOT is `player.name` (set at `join_game`); ADR-0125's passive mirror copies it into
`profile.name` on each rated game (`live_player_name` → `apply_pvp_rating`'s `..winner`/`..loser` spreads).

## Decision

### D1 — Write target: **Option (a)** — the reducer writes `player.name` only
`set_profile_name` resolves the caller's `player` row (via a `match`, not a `let Some(..) =` split-binding),
validates the name with `guards::validate_name` (the exact same rules as `join_game` — SSOT, reject-not-clamp),
sets `player.name`, and writes the row back. It **does not touch the `profile` table.** The rename surfaces on
the public leaderboard on the caller's next rated game via the ADR-0125 mirror (≤1-game staleness — the
already-accepted mirror contract).

Rejected alternatives:
- **(b) `player.name` + eager `profile.name` mirror-if-exists.** The eager profile write adds a third
  `profile().identity().update(`, breaking the `==2` whole-file update pin (`ranking_tests.rs:596`,
  `d1_scan_no_eager_write_in_get_or_init`) — a deliberate ADR-0125 D1 "refresh is in-memory only"
  invariant. Loosening the pin to `==3` would weaken an existing gate and contradict ADR-0125. The
  immediacy benefit has no observer this slice (UI parked). If instant leaderboard reflection is later
  wanted, it is a conscious re-baseline of that pin in a follow-up, not a free amendment.
- **(c) `profile.name` only.** The ADR-0125 mirror overwrites `profile.name` from the stale `player.name`
  on the next rated game — a silent-revert bug (traced end-to-end through `get_or_init_profile`'s Some arm).

The spec wording "validate_name at the profile-write layer" (M-playtest-c) is reconciled here: the
name-setter is **colocated in `ranking.rs`** (the profile module, per ADR-0119 D6 A2 coupling) but writes
the `player.name` SSOT, not `profile.name` directly.

### D2 — Cross-domain `player.name` write from `ranking.rs` is acceptable
`ranking.rs` already reads `player` (`live_player_name`); it now also writes `player.name`. No invariant
forbids a `player` write outside `movement.rs` (the eval A2 keys on `ctx.db.profile()`, not `player`; a
production `player().identity().update` already lives in `guards.rs:94`). The reducer mutates only `.name`
and writes the whole row back within one transaction (SpacetimeDB reducers are single-threaded/transactional
— no lost-update). The `match`-form read is required to keep the `= ctx.db.player()` split-binding pin
(`ranking_tests.rs:628`) green.

### D3 — RL-7 tooth refinement (amends ADR-0119 D6) — monotone-preserves the security property
The two RL-7 "zero `#[spacetimedb::reducer]` in `ranking.rs`" teeth
(`evals/ranking-security.eval.mjs` A1 + `pvp_tests.rs::m17a_rl7_server_ranking_module_invariants` (i))
are refined to: **exactly one reducer, whose identifier is `set_profile_name`, whose body is
profile-untouching** (contains `validate_name(` + `player().identity().update(`, and none of
`profile().identity()` / `profile().insert` / `get_or_init_profile(` / `refresh_profile_name(` /
`= ctx.db.profile()`). The security invariant — *no client-callable reducer writes `profile`
rating/wins/losses* — is preserved because the one allowed reducer touches no `profile` table at all;
the whole-file `==2` update pin is the backstop against any helper adding a profile write
(red-team F1/F2). The `get_or_init_profile(` / `.insert` bans close the "rename creates a rating-1000
leaderboard row for an unrated player" hole (red-team F3). The tie of count-to-name closes the
"wrong-named rating reducer with a `set_profile_name` comment" evasion (red-team F4). The name-only
property uses an **allowlist** (the reducer touches nothing profile) rather than a blocklist of
`rating:`/`wins:` needles, which mutable-binding/helper-indirection writes evade (red-team F1/F2).

Supersedes the ADR-0119-era comment "a future name-setter belongs in a separate reducer file"
(`pvp_tests.rs:1123`): the name-setter belongs **in** `ranking.rs` (A2 couples all `profile` access there;
the declared touch-set is `ranking.rs`).

### D4 — Validation only; no cooldown; homoglyph/duplicate names accepted for the closed test
No rename cooldown / rate-limit (closed-solo-playtest YAGNI; "RL-7 tooth" denotes the module-write-only
eval tooth, not a rate-limiter). `validate_name` already bans control/zero-width/bidi-override characters
but not homoglyphs (Cyrillic/fullwidth) or duplicate display names; for a closed solo playtest there is no
adversary, and script-restriction would reject legitimate non-Latin names (katakana etc. are deliberately
allowed). Homoglyph/duplicate leaderboard-name mitigation and any rename cooldown are **deferred to a
public-exposure milestone** (red-team F5/F6, recorded not silent).

## Consequences

- Players can rename in-session; the leaderboard reflects it on the next rated game (mirror-honest).
- `ranking.rs` goes 0→1 reducer; `profile` rating/W/L remain module-write-only. All eight pre-existing
  RL-5/RL-7/ADR-0125 byte-pins over `ranking.rs` stay green (the reducer adds no profile write, no
  `apply_pvp_rating` call, no delete, no split-binding).
- `client/src/module_bindings/**` gains `reducers.setProfileName` (mechanical regen), unblocking pt-c1b.
- Source-scan + eval is the honest proof (ReducerContext is not unit-constructible for this module); the
  runtime rename→leaderboard round-trip is pt-c1b's e2e charter.
