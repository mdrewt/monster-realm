# ADR-0120 — Ranked leaderboard client UI: pure-subscription profile mirror, deterministic comparator, fully-covered DOM shell

**Status:** Accepted
**Date:** 2026-07-17
**Slice:** m17b
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui
**Decision:** Pure-subscription leaderboard: `profile` mirrored into the store with no remove path, a strict-total-order comparator in a pure model, and a zero-callback KeyL DOM shell kept under coverage so the m17c-owned eval set is untouched.

---

## Context

m17a (ADR-0119) shipped the ranked spine: a public, never-deleted `profile` table (PK identity,
`name`, `rating: i32`, `wins`/`losses: u32`) written only by module code. m17b surfaces it as a
client leaderboard overlay (spec RL-13) with no client write path (RL-15). The slice runs as a
fan-out pair with m17c, which owns `evals/**` and `client/e2e/**` — so this slice may not touch
any eval, including the `dom-shell-coverage-exclusion` eval that exact-set-guards the
`vite.config.ts` coverage-exclude list.

Scope discoveries at plan time (recorded in `docs/specs/m17b-plan.md`):
- `set_profile_name` does not exist server-side (m17a shipped none). Delivering the name-edit
  flow requires `server-module/src/ranking.rs`, a bindings regen, and the RL-7 eval-tooth
  amendment pre-staged in ADR-0119 D6 — all outside this slice's file partition. **Parked.**
- RL-14 (post-battle rating delta) requires `battleModel.ts`/`battleView.ts` edits outside the
  declared touch set. **Parked** alongside `set_profile_name` as one follow-up slice.

## Decisions

### D1 — Store mirror with deliberately NO remove path

`StoreProfile` (a `type` alias — the store's probe-cast test convention) joins the
AuthoritativeStore keyed by identity hex, ingested by `onInsert`/`onUpdate` only.
**No `onDelete` handler and no `removeProfile` method exist**: RL-2/ADR-0119 D1 guarantee
`profile` rows are never deleted, so a remove path would be unreachable dead code whose only
effect is to mask a future server-side regression. A tripwire comment at the wiring site cites
RL-2; if the server ever starts deleting profiles, the missing handler surfaces in review
instead of being silently mirrored. `reset()` clears the map on reconnect (rows are re-delivered
whole by the re-applied `SELECT * FROM profile` subscription — never merged, ADR-0014).

### D2 — Comparator is a strict total order over (rating, raw name, identity)

`buildLeaderboardViewModel` sorts a copy: rating descending (`b.rating - a.rating` — exact,
i32 range diff < 2^53), then raw `name` ascending by code-unit comparison (case-sensitive;
**never `localeCompare`/`Intl`** — locale-dependent output would break the determinism
discipline the project applies everywhere else), then identity hex ascending. Identity is a PK,
so the order is total: any input permutation yields the identical output (pinned by test).
The empty-name display fallback (`'#' + identityHex.slice(0, 8)`) is display-only; the
tie-break uses the raw name so rendering can never perturb ordering. No row cap (YAGNI —
the ranked population is bounded by players with a decisive ranked battle).

### D3 — The view ships fully covered, NOT coverage-excluded (deviation from the DOM-shell convention)

Every prior overlay view is excluded from vitest coverage as a DOM shell. That list is
exact-set-guarded by the `dom-shell-coverage-exclusion` eval (`findUnsanctionedExclusions`),
which m17c owns this cycle. Adding `leaderboardView.ts` to `vite.config.ts` excludes would fail
the eval; editing the eval would collide with the sibling. Resolution: `leaderboardView.ts`
stays **inside** coverage and is fully unit-driven under happy-dom (both constructor throw
paths, empty-board branch, row rendering, own-row marker). This is a deliberate, slice-local
deviation, not a new convention; m17c (or a later doc slice) may sanction the exclusion and
downgrade the tests to the shell convention if it chooses — the eval stays green either way.

### D4 — KeyL toggle, trade-style refresh, and the battle-show hide

The overlay binds KeyL (first free key), participates in the full mutual-exclusion lattice
(all ten existing overlays negated in its open guard; itself added to every sibling guard,
both held-reissue guards, and the movement-suppression block), and refreshes via a
trade-style batch listener — refresh only while visible (ADR-0014), never auto-show: nothing
about a rating change should pop UI unbidden. Two review findings are load-bearing here:
- `refreshBattle`'s 'show' branch must hide the leaderboard (red-team): a challenger with the
  board open when the opponent accepts gets a battle row pushed; the battle overlay supersedes,
  exactly as it supersedes box/raising/evolution.
- `pvpView` must NOT be added to the pvp listener's `anyOverlayVisible` (refuted plan-review
  finding): `pvpView.refresh(vm, false)` hides the view — its absence from that expression plus
  the `(pvpView?.visible ?? false)` disjunct is what preserves a manually-opened pvp overlay.

### D5 — RL-15 client mirror: zero-callback view + source-scan tooth

`LeaderboardView`'s constructor takes no callbacks (contrast TradeView/PvpView) — there is
nothing to send. A source-scan test (readFileSync + `indexOf`, no dynamic RegExp) asserts
`leaderboardModel.ts`/`leaderboardView.ts` reference no `module_bindings`, `reducers`, or
`conn.` — a future editor wiring a write path trips it. The authoritative server-side teeth
(RL-7/RL-10/RL-2) live in m17c's `ranking-security` eval, not here.

## Consequences

- The leaderboard renders names via `textContent` only — `profile.name` is player-controlled
  data (24-char bound inherited from `join_game`'s `validate_name` via `get_or_init_profile`;
  no second bound at the profile layer — the future `set_profile_name` MUST re-apply
  `validate_name`).
- `isOwn` relies on main.ts module-scope `identity` (assigned in `onReady`); correct under
  SpacetimeDB 2.6 same-identity reconnects — documented assumption, not defended.
- Parked to a follow-up slice (supervisor to schedule after m17c): `set_profile_name` flow
  (+ ADR-0119 D6 RL-7 tooth amendment + RL-7 rejection UX) and RL-14 post-battle rating delta
  (battleModel/battleView).

## Residuals

- If a later slice adds server-side profile deletion (it must not — RL-2), the client has no
  remove path by design; the D1 tripwire comment is the discovery point.
- The interim coverage posture (D3) leaves `leaderboardView.ts` as the only view under
  coverage; a future m17c/doc slice may normalize it into the sanctioned exclusion set.
