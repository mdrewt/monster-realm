# 0121 — m17c ranked evals tail: sql-based server-truth e2e, checker-import reuse, no-op-body hardening

**Status:** Accepted
**Date:** 2026-07-17
**Slice:** m17c (M17 ranked ladder — evals tail, RL-16/17/18)
**Supersedes:** —
**Amends:** —
**Subsystems:** ci-gates, security-authz
**Decision:** RL-18 e2e reads rating truth via `spacetime sql` (no client hook; decoupled from m17b); RL-17 re-pinned by importing the frozen eval's checkers plus a guard-block-body hardening that kills the no-op-body evasion.

## Context

m17a (ADR-0119) shipped the ranked-ladder spine: the never-deleted `profile` table, integer Elo in
`game-core`, the `settle_pvp_battle` once-only funnel (sole caller of `ranking::apply_pvp_rating`),
and four PvE-reducer PvP-reject guards in `battle.rs`, eval-pinned in
`evals/battle-reducer-security.eval.mjs`. The M17 spec defers the ranking eval suite and the ranked
two-context e2e to m17c (RL-16/17/18), running fan-out-parallel with m17b (client leaderboard UI,
owns `client/src/**`).

## Decisions

### D1 — RL-18 e2e reads server truth via `spacetime sql`, not a client hook

The two-context ranked e2e (`client/e2e/ranked-forfeit.spec.ts`) drives challenge → accept via the
M16b DOM testids (`pvp-challenge-player-btn`, `pvp-accept-btn`) and triggers the forfeit by
**closing player B's browser** — there is deliberately no client-callable forfeit reducer;
`pvp::forfeit_on_disconnect` (lib.rs) is the only user-reachable forfeit path, and the 60s
`PVP_TURN_DEADLINE_MS` cannot race a sub-minute test. Rating assertions run `spacetime sql` via
`execSync` from the spec's node context (reusing global-setup.ts's env-shape validation), because:

- `__game()` exposes no profile data and `window.__mrPvp` does not exist; adding either is a
  `client/src/**` change owned by concurrent sibling m17b — the sql read keeps the slices disjoint.
- Server truth is strictly stronger than a client-subscription echo for a zero-sum invariant.

Identity contract (resolved empirically): `spacetime sql` renders Identity as `0x` + 64 lowercase
hex, un-truncated; the client SDK hex may omit the prefix. The spec normalizes both sides
(lowercase, strip `0x`), identifies the winner by the `wins == 1` row, cross-checks it is player A
(the survivor), asserts winner `1000+Δ`/loser `1000−Δ` with `Δ ∈ [1,31]` (never the K/2 magic
number) and sum == 2000, and **hard-fails with the raw sql output embedded** if parsing matches no
rows. Assertions are identity-scoped, never global row counts — profile rows are never deleted and
persist into later alphabetical spec files of the shared `--delete-data` world.

Side-B note: the acceptor is `opponent_identity`; the client store's `ongoingBattle`/battle view
key on `player_identity` only, so battle-liveness is asserted on A's page exclusively (B's
observable accept-success signal is its pvpView auto-hiding).

### D2 — Checker-import reuse from the frozen battle-reducer-security eval

`evals/ranking-pve-exclusion.eval.mjs` imports `stripRustComments` / `extractReducerBody` /
`stripRustStrings` / `hasPvpRejectGuard` / `pvpGuardAfterOngoingCheck` from
`./battle-reducer-security.eval.mjs` — the exports m17a staged "for reuse by future m17c evals" —
rather than copying them. The import is guarded: a missing export turns the eval RED (structured
`{pass:false}`), never an unhandled throw, so a rename in the frozen file surfaces as a clean
failure. RL-17's re-verification therefore fails independently in an m17c-owned file if a future
battle.rs refactor drops a guard, without duplicating checker code.

### D3 — No-op-body hardening: guard blocks must contain the rejection

The frozen eval documents a residual evasion it cannot fix (it is off-limits post-merge):
`if is_ranked_pvp(&battle) {}` — needle present, guard inert. m17c adds
`hasPvpRejectWithNonEmptyBody`: strip comments+strings → locate the `if is_ranked_pvp(&battle)`
needle → walk to the block `{` → brace-depth-match the block → require `return Err` **inside that
sub-slice only**. Fixtures kill: empty body, whitespace/comment-only body, log-only body, and the
positional evasion (`return Err` appearing after the guard block). Honest residual, documented in
the eval: nested dead code (`if is_ranked_pvp(&battle) { if false { return Err(..) } }`) still
passes a static scan — that class is owned by mutation testing and the Rust `pvp_tests.rs` suite.

### D4 — RL-16 needles mirror the Rust gates, two-needle form (review amendment AM-1)

`evals/ranking-security.eval.mjs` re-pins RL-2/7/10 at the eval layer as toolchain-boundary
defense-in-depth against `server-module/src/pvp_tests.rs` (a JS gate still bites if the Rust test
module is cfg-gated off). The once-only criterion uses the same two-needle strategy as the Rust
gate (ADR-0119 D3): path-qualified `ranking::apply_pvp_rating(` == 1 in pvp.rs, bare
`apply_pvp_rating` == 0 in every other non-test domain file read individually — catching
`use`-import aliasing that a single path-qualified count misses. The never-deleted scan carries
both the chained-delete needles and the split-binding needle (`= ctx.db.profile()` outside
ranking.rs), each with a fixture that its own needle actually catches. The module-write-only scan
(`ctx.db.profile()` only in ranking.rs) is intentionally coupled to ADR-0119 D6: m17b's
`set_profile_name` is expected inside ranking.rs; if it lands elsewhere the allowlist must be
widened in that PR, not silently.

### D5 — Two eval files split by threat surface

`ranking-security` (profile persistence + rating funnel; reads ranking.rs/pvp.rs/lib.rs) and
`ranking-pve-exclusion` (battle-reducer PvE-path closure; reads battle.rs) follow the M16c
three-file pvp-eval precedent: a battle.rs refactor fails the pve-exclusion gate without muddying
the module-write-only signal, and vice versa.

## Consequences

- m17b must keep `set_profile_name` (and any profile access) inside ranking.rs or amend the A2
  allowlist explicitly (D4); the RL-7 tooth amendment path is pre-staged in ADR-0119 D6.
- The e2e depends only on M16b-era testids and `__game()` — leaderboard UI changes in m17b cannot
  break it; the four battle.rs guard shapes remain load-bearing needles (comment before
  "simplifying" them).
- Later spec files inherit persisted profile rows from the ranked e2e; any future e2e asserting
  global profile counts must scope by identity instead.

## Residuals

- Nested-dead-code evasion of D3 (documented, owned by mutation testing).
- `pvpGuardAfterOngoingCheck` remains a positional byte-offset check (inherited from the frozen
  eval; semantic ordering is pinned by the Rust tests).
