# ADR-0078: Practice-battle XP multiplier (0.1×)

**Status:** accepted  
**Date:** 2026-07-03  
**Decider:** Drew Teter  
**Context:** M12.5e follow-up sub-slice `12.5e-2-impl`

---

## Context

The sixth-review residuals spec (M12.5e) identified a riskless XP farm: a player
can start a battle with themselves (`opponent_identity == ctx.sender`), their
side-B monsters take no persistent damage between rounds, `heal_party` is free and
uncooldown-gated, and XP is awarded on any `SideAWins` outcome regardless of
battle provenance. The net result is unlimited XP for zero in-game cost.

The decision (Drew, 2026-07-03) was to allow "practice XP" rather than ban it
outright, because the ability to train freely (e.g. to learn the mechanics)
is intentionally preserved. The deterrent is a 90% penalty, not a hard block.

Wild battles (opponent is `WILD_IDENTITY`) remain fully rewarding — they are the
intended progression path and should not be penalised.

---

## Decision

> **Introduce `practice_xp_reward(base: Xp, is_practice: bool) -> Xp` in
> `game-core/src/combat/xp.rs`.** In `write_back_battle_results`, compute
> `is_practice = (battle.opponent_identity != WILD_IDENTITY)` once (loop-invariant),
> then call `practice_xp_reward(base_xp, is_practice)` in place of the raw
> `battle_xp_reward(...)` result. Wild battles pass `is_practice = false` and
> receive the full reward unchanged.

Rule:

```
practice_xp_reward(base, is_practice):
  if is_practice: floor(base / 10)  // integer division, may yield 0
  else:           base               // wild/NPC: unchanged
```

Integer division (Rust `/` on `u32`) gives exact floor truncation. A base reward
of 1–9 XP results in 0 practice XP — the minimum is 0, not 1.

---

## Rationale

| Option | Notes |
|--------|-------|
| **Ban self-battles entirely** | Breaks legitimate use (testing, mechanics exploration). Rejected. |
| **0.1× multiplier (chosen)** | Preserves practice XP, makes the farm economically inefficient (10× slower). Minimal implementation surface. |
| **Rate-limit start_battle** | Orthogonal concern; listed in M16 security pass. Does not address XP farm directly. |
| **Decay multiplier based on repetition** | Requires persistent state, much larger scope. YAGNI. |

### Why separate from `battle_xp_reward`, not a param on it

`battle_xp_reward` has a `+ 1` floor guaranteeing `Xp >= 1` (invariant tested by
`prop_battle_xp_reward_always_at_least_1`). The practice rule must be able to yield
0 (a 1–9 XP reward floors to 0). Keeping them separate means practice reduction
composes *after* the base formula and does not perturb the `>= 1` invariant.

### Why bundle `is_practice: bool` into the game-core function

The alternative (bare `practice_xp(base) -> Xp`) requires the server to write the
conditional inline. Putting the conditional inside the pure function keeps the SSOT
complete: the server only computes a single boolean from provenance and delegates
all policy arithmetic to `game-core`. Structural tests can then gate on the
`practice_xp_reward(` call needle.

### Rounding choice (floor, may reach 0)

Arithmetic simplicity, no special-case needed. A 0-XP result for trivially low-level
self-battles is a sensible emergent behaviour (no benefit whatsoever).

---

## NPC provenance

The spec says "not WILD_IDENTITY and not an NPC". At the time of this ADR, NPC
battles are not launched via `start_battle` (they are not yet implemented as a
reducer path). When NPC-driven battles land, the practice check should be amended
to: `is_practice = !is_wild_or_npc(opponent_identity)`.
Until then, only the `WILD_IDENTITY` sentinel matters — one call-site change.

---

## SSOT placement

The `practice_xp_reward` function lives in `game-core/src/combat/xp.rs` and is
re-exported up to `game_core::practice_xp_reward`. The server shell
(`server-module/src/battle.rs`) calls it via the rule boundary — no inline
arithmetic in the reducer. This upholds the functional-core / imperative-shell
split (ADR-0003). `WILD_IDENTITY` is already imported at `battle.rs:23`.

---

## Proof-of-teeth obligations

1. **Unit tests in `game-core/src/combat/xp.rs`:**
   - Known-answer: `practice_xp_reward(Xp::new(64), true)` == `Xp::new(6)` (floor(64/10)=6)
   - Pass-through: `practice_xp_reward(Xp::new(64), false)` == `Xp::new(64)` (kills impl ignoring flag)
   - Floor-to-zero: `practice_xp_reward(Xp::new(9), true)` == `Xp::new(0)` (kills min-1 impl)
   - Property: `practice_xp_reward(x, true).value() <= x.value()` for all x (any is_practice)
   - Zero-input: `practice_xp_reward(Xp::new(0), true/false)` == `Xp::new(0)` (no +1 bias)
   - Composed zero floor: `practice_xp_reward(Xp::new(9), true)` → `apply_xp_gain(start, 0)` → `did_level_up=false`
   - RT-PX-01: minimum `battle_xp_reward` output (1) through practice floors to 0 (pipeline invariant)
   - RT-PX-02: exact divisor — `battle_xp_reward(L1, bst=1, L45)=10` → `practice_xp_reward=1` (0→1 boundary)

2. **Structural source-guard in `server-module/src/battle_tests.rs`:**
   - Body MUST contain `practice_xp_reward(` — kills inline `/ 10`
   - Body MUST contain `practice_xp_reward(base_xp,` — secondary needle guards against string-literal bypass
   - Body MUST contain `WILD_IDENTITY` — provenance check present; kills hardcoded `is_practice`

3. **Eval proof-of-teeth in `evals/practice-xp.eval.mjs`:**
   - TEETH A (bad fixture): body without `practice_xp_reward(` → eval flags it RED
   - TEETH B (good fixture): body with `practice_xp_reward(base_xp, is_practice)` → eval passes
   - Two-needle check: both `practice_xp_reward(` and `practice_xp_reward(base_xp,` required

---

## Affected files

| File | Change |
|------|--------|
| `game-core/src/combat/xp.rs` | Add `pub fn practice_xp_reward(base: Xp, is_practice: bool) -> Xp` + 8 tests |
| `game-core/src/combat/mod.rs` | Re-export `practice_xp_reward`; update xp submodule doc |
| `game-core/src/lib.rs` | Re-export `practice_xp_reward` via `pub use combat::` |
| `server-module/src/battle.rs` | Hoist `is_practice` above XP loop; call `practice_xp_reward` |
| `server-module/src/battle_tests.rs` | Two source-guard tests (primary + secondary needle) |
| `evals/practice-xp.eval.mjs` | New eval with TEETH A + B, two-needle `hasPracticeXpCall` |

Schema is **not changed** — no new tables, no column additions. No bindings regen.

---

## Consequences

- Self-battles earn 10× less XP than wild battles of equal level/BST.
- Wild-battle XP is unchanged.
- A future NPC-battle path must amend the `is_practice` predicate (noted above, one line).
- The 0-XP-floor for small rewards is accepted as intended (deters micro-farming).
- ADR next-free after this: 0079.
