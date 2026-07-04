# 0049. Panic-as-content-invariant policy in the pure core (+ rule-core contracts)

- Status: accepted
- Date: 2026-06-27
- Milestone: M8.5b (rule-core contracts)

> **ADR numbering note.** The M8.5 spec (§3 "Rule-core contracts", §4, §5) proposes
> "ADR-0047" for this policy. That number is **already taken** — M8d landed ADR-0046
> (player inventory) and ADR-0047 (recruit resolution), and M8.5a landed ADR-0048
> (`start_battle` provenance). The next free number is **0049**, allocated here. The
> stale spec/PLAN cross-references are reconciled by the deferred M8.5e doc sweep; this
> ADR is the SSOT for the decision.

## Context and problem statement

A multi-lens review of the delivered combat spine surfaced four latent rule-core
correctness gaps and one undocumented panic. None is reachable in valid play today, but
each is cheap to make impossible by construction (or to record honestly), and M9+ builds
directly on this code. This ADR records the load-bearing decisions; the mechanical fixes
land in the same slice (`game-core/src/combat/`, `game-core/src/monster/`, and the
`battle_monster_from_row` trust boundary in `server-module/src/lib.rs`).

The five rule-core contracts (EARS criteria, spec §3):

1. **`calc_damage` divide-by-zero** — the damage formula divides by
   `defender.stats.defense` (`game-core/src/combat/damage.rs`). `defense == 0` is a hard
   integer divide-by-zero panic in **both** debug and release.
2. **`turn_number` overflow** — `resolve_turn` does `state.turn_number += 1` on a `u16`
   (`game-core/src/combat/resolve.rs`). At `u16::MAX` this panics (debug) / wraps to 0
   (release).
3. **`derive_stats` truncation** — `derive_stats` casts a `u32` intermediate with
   `raw as u16` (`game-core/src/monster/rules.rs`), a **silent truncation** (not a
   saturation) for any out-of-range input.
4. **BST ownership** — the base-stat-total used by the XP rule was defined in the server
   shell (`loser_base_stat_total`, `server-module/src/lib.rs`), not in the rule core,
   violating SSOT / functional-core ownership; it also summed `u16` fields with plain `+`
   (silent overflow in release if a base stat ever exceeded 255).
5. **Panic-as-content-invariant** — `resolve_one_attack`
   (`game-core/src/combat/resolve.rs`) panics on a skill id not found in the skill
   registry. This is deliberate (a content-integrity failure, not a player error), but it
   was undocumented as a *gated* decision.

## Decision outcome

### 1. `calc_damage` — precondition + `debug_assert`, reject at the boundary, **no clamp**

The pure formula keeps `/ defense` unchanged. `calc_damage` documents
`defender.stats.defense >= 1` as a **precondition** and adds
`debug_assert!(defender.stats.defense > 0, …)` so a violation fails loud in dev/test.
The divisor is **not** silently clamped (`.max(1)` was debate-rejected, spec §7 — silent
clamp lost to *make-illegal-states-unrepresentable* + *defensive-code-at-boundaries-only*
+ *fail-loud*).

The production guarantee is the **trust boundary**: `battle_monster_from_row`
(`server-module/src/lib.rs`) — which marshals a stored `Monster` row (with precomputed
derived-stat columns) into a `BattleMonster` — now returns `Result<BattleMonster, String>`
and **rejects** (`Err`) a row whose `stat_defense == 0` (parse-don't-validate). The three
call sites are all inside `Result`-returning reducers (`?`-chained); the helper's inline
unit tests `.unwrap()` their nonzero fixtures.

The other `BattleMonster` constructor, `wild_battle_monster`, derives defense via
`derive_stats` from a `validate_content`-guaranteed base stat `>= 1`; the non-HP stat
floor is `((2·base+iv+ev/4)·lvl/100 + 5) · nat_num/nat_den ≥ 5 · 9/10 = 4` (min nature
multiplier `9/10`), so it **cannot** produce `defense == 0`. No extra guard is needed
there.

**Accepted residual (red-team).** `debug_assert` is a no-op in release, and
`BattleMonster` is a `pub` struct freely constructible (e.g. in `sim-harness`, unit
tests, or future code) with `defense == 0`, which would still divide-by-zero in a release
build. This is **by design**: the pure core trusts its documented precondition; the
boundary (DB → core) is where the invariant is *enforced*, and the `debug_assert` catches
any in-repo violation in CI (which runs the debug profile). Adding a structural
`BattleMonster` smart-constructor was considered and rejected as scope-creep for this
slice (it would touch every constructor and the value-object's public API); it is recorded
as a possible future hardening, not a gap this slice leaves open in the production path.

### 2. `turn_number` — terminate at a defined terminal outcome (reuse `Fled`)

`resolve_turn` guards **before** any state mutation (immediately after the existing
`outcome != Ongoing` early-return, before `state.turn_number += 1` and before any swap or
attack resolves): if `state.turn_number == u16::MAX`, it sets
`state.outcome = BattleOutcome::Fled` and returns the (empty) event list. Because the
guard precedes all mutation, **no partial turn is applied** (atomicity preserved) and
`turn_number` never wraps.

**Chosen: reuse `BattleOutcome::Fled`** (the existing no-winner terminal) rather than add
a new `Draw`/`TurnLimit` variant. Rationale: `BattleOutcome` derives `SpacetimeType` and
is **stored in the public `battle` table**; adding a variant is an additive *stored-enum /
schema* change that forces edits into `server-module` match sites, the client, and a
bindings regen — **outside this slice's touch-set** and against the spec's "no
schema-shape change" scope guard (spec §2). Reusing `Fled` requires zero schema/enum
change and stays entirely in `game-core/src/combat/`.

**Deliberate semantics:** a turn-limit terminal grants **neither XP nor win credit** —
identical to a flee. XP is gated strictly on `outcome == SideAWins`
(`write_back_battle_results`), so `Fled` correctly suppresses it; `battle_wild` GC fires on
any terminal, which is also correct. The branch is **unreachable in valid play** (a real
battle ends in a handful of turns, never 65 535), so this is a no-behavior-change-in-valid-
play hardening. The only cost of reuse is that a client cannot distinguish "player fled"
from "turn cap" on the `outcome` field alone — a cosmetic UX nuance for an unreachable
state, deferred to the client slice (M8.5f) if ever surfaced. **No spurious
`BattleEvent::BattleEnd` is emitted** (that event carries a `winner`; a turn cap has none).

### 3. `derive_stats` — explicit saturation

Both `raw as u16` casts (HP and the non-HP loop) become
`u16::try_from(raw).unwrap_or(u16::MAX)` (saturate-don't-wrap). For all
`validate_content`-bounded inputs (base ≤ 255, IV ≤ 31, EV ≤ 252, level ≤ 100) the
maximum `raw` is < 720, so this is **behavior-identical in valid play**; saturation only
bites a `StatBlock` constructed directly above the content-validated range (tests,
`sim-harness`, fuzzing, or a future widening of the validator). Native and wasm compile
the same source, so determinism / prediction-parity is unaffected.

### 4. BST — owned by the rule layer

A pure `game-core` function `base_stat_total(base: &StatBlock) -> u16` (saturating
addition) is added to `game-core/src/combat/xp.rs`, co-located with its sole consumer
`battle_xp_reward` (the XP rule owns the BST definition), and exported via `combat/mod.rs`
+ `game-core/src/lib.rs`. The server helper `loser_base_stat_total` keeps its name and
`(&SpeciesRow) -> u16` signature (so its call site and tests are untouched) but is reduced
to **pure marshaling**: it builds a `StatBlock` from the six `SpeciesRow.base_*` fields and
calls the core function. The old inline `+`-sum is **deleted** — no dual SSOT. Saturating
addition removes the silent-overflow residual; for valid content (sum ≤ 1530) the result
is unchanged.

### 5. Panic-as-content-invariant — deliberate, gated, **honestly disclosed**

The `resolve_one_attack` panic on skill-not-found is recorded as a deliberate
content-integrity invariant, in both this ADR and an expanded doc-comment that **names the
guarantee**: `validate_content` (`game-core/src/content.rs`) cross-checks that every
`species.learnable_skill_ids` references an existing skill at content-load time and that
every species declares at least one learnable skill (empty-moveset guard, M10.5a), and
`battle_monster_from_row` / `wild_battle_monster` both reject a monster whose
`known_skill_ids` intersection with loaded skills is empty (defense-in-depth, M10.5a). So in the **steady state** — content validated at sync, battles started
against that content — the panic is unreachable.

**Honest residual (red-team — the spec's own red-team note demands the ADR not overstate
the guarantee).** `validate_content` runs at `sync_content` time and **cannot
retroactively repair in-flight `Battle` rows**. If a `sync_content` *removes* a skill while
a battle is active, that battle's serialized `BattleMonster` may still carry the now-stale
skill id in `known_skill_ids`; a subsequent `resolve_one_attack` (or `pick_best_skill`)
would then panic. This is a **pre-existing, accepted residual** (already logged in the
project handoff as "`pick_best_skill` `.expect()` panics on STALE skill defs"). It is
**out of scope** for this slice (the fix is to make the battle reducers return `Result`
instead of panicking — a server-module change well outside the declared touch-set). This
ADR records it explicitly so the "never fires in production" claim is scoped to the
steady state and the in-flight-content-mutation window is named, not hidden.

## Considered alternatives (key forks)

- **`calc_damage` silent `.max(1)` clamp** — rejected (debate, spec §7): masks the illegal
  state, spreads defensive code into the pure core, and hides a corrupt row instead of
  rejecting it at the boundary. A future M14 debuff step clamps *upstream* where a debuff is
  applied, not inside the formula.
- **`turn_number` new `BattleOutcome::Draw`/`TurnLimit` variant** — rejected: additive
  stored-enum/schema change, widens the slice beyond its touch-set (server + client + binding
  regen) for an unreachable state; the exhaustive-match benefit is not worth the blast radius.
- **`derive_stats` assert `base <= 255`** (the spec's alternative) — rejected in favour of
  saturation: the precondition holds for content-validated input but `derive_stats` is a pure
  function callable with any `StatBlock`; saturating is total and matches the workspace
  saturate-don't-wrap invariant without adding a panic to a hot pure path.

## Proof-of-teeth (gating tests, authored by the `tester` from the EARS criteria)

- `calc_damage` with `defense == 1` returns a valid damage (no divide-by-zero); a
  `#[cfg(debug_assertions)] #[should_panic]` test proves the `debug_assert` fires on
  `defense == 0`. A boundary test feeding a `Monster` row with `stat_defense == 0` to
  `battle_monster_from_row` asserts `Err` — and **bites**: removing the reject makes it
  fail (the fixture reaches the formula instead of being rejected).
- `resolve_turn` at `turn_number == u16::MAX` returns with `outcome == Fled`, **no panic**,
  and `turn_number` **does not wrap to 0**.
- `derive_stats` with a large-base `StatBlock` (raw > `u16::MAX`) yields `u16::MAX`
  (saturation) — under the old `as u16` the value wraps to a small number, so the test is
  non-vacuous.
- `base_stat_total` known-answer (`{45,49,49,65,65,45}` → 318) and saturation
  (all `u16::MAX` → `u16::MAX`) prove the pure function and its saturating add.

## Consequences

- **Positive:** Four latent rule-core gaps are impossible by construction (or saturate
  explicitly); the BST is single-sourced in the rule layer; the deliberate pure-core panic
  is documented and its guarantee named *and scoped*. No player-facing behavior changes in
  valid play.
- **Accepted residuals (recorded, not fixed here):** (a) `BattleMonster` is freely
  constructible with `defense == 0` → release-mode divide-by-zero outside the DB boundary
  (by design; structural smart-constructor is future work); (b) in-flight battle rows are
  not repaired when `sync_content` removes a skill mid-battle → the `resolve_one_attack` /
  `pick_best_skill` panic can fire in that window (pre-existing; fix = `Result`-returning
  battle reducers, a future server-module hardening); (c) **the `turn_number` terminal
  guard covers `resolve_turn` only.** The `attempt_recruit` reducer
  (`server-module/src/lib.rs`) advances `turn_number` with a bare `+= 1` *out-of-band*
  (recruit-failure path, before `resolve_enemy_turn`), which would still panic(debug)/
  wrap(release) at `u16::MAX`. This is **pre-existing** (landed in M8d), **unreachable in
  valid play** (a battle never reaches 65 535 turns), and its fix is in `attempt_recruit`
  — *outside this slice's declared touch-set* (server `lib.rs` was authorized here only for
  the `battle_monster_from_row` boundary reject), so it is deliberately deferred rather than
  silently widening the slice. Follow-up: route the recruit-failure wild turn through a
  guarded path (or replicate the `== u16::MAX` guard before the out-of-band increment).
  (d) **`wild_battle_monster` has no structural `defense > 0` guard.** It is safe today
  because `derive_stats` from a `validate_content`-guaranteed base stat `>= 1` yields a
  non-HP floor `≥ 4` (min nature multiplier `9/10`), but that invariant lives in this ADR's
  arithmetic, not in code — a future floor-lowering refactor could regress it. The
  asymmetry with `battle_monster_from_row` (which *does* reject `defense == 0`) is recorded;
  closing it (a `debug_assert` in `wild_battle_monster`) is a server-module change outside
  this slice's touch-set.
- **References:** ADR-0003 (rule SSOT / functional-core), ADR-0006 (additive schema —
  *why* we don't add a stored-enum variant lightly), ADR-0041 (integer damage formula /
  `u64` intermediates), ADR-0042 (battle table public PvE), ADR-0045 (`wild_battle_monster`
  / `WILD_IDENTITY`), ADR-0048 (M8.5a battle security — same slice family).
- **Follow-ups:** a future hardening slice converts the battle reducers
  (`submit_attack` / enemy-AI path) to return `Result` rather than panic on a stale skill
  id, closing residual (b); a `BattleMonster` smart-constructor would close residual (a) if
  the value object ever crosses an untrusted boundary other than `battle_monster_from_row`.
