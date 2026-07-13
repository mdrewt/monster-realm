# ADR-0097 — M14 Close: Phase B Complete

**Status:** Accepted
**Date:** 2026-07-11
**Slice:** m14f (doc-keeper close; doc-only, no production code)
**Supersedes:** —
**Amends:** —
**Subsystems:** battle, tooling-docs
**Decision:** Milestone closure record for Phase B (M14 status effects, abilities, weather); verifies integrated correctness and queues residuals for M14.5 Phase C.

---

## Context

M14 (Deeper battle systems — status effects, abilities, weather) delivered in five
production slices (m14a–m14e), each squash-merged to master with green local CI. This
ADR records the post-integration verification of the integrated whole and formally
closes Phase B (M11–M14).

---

## Post-Integration Verification

Verified on master at `523668f` (m14e squash-merge tip) against the integrated whole.

**Gates checked:**

- **bindings-drift = 0** — `module_bindings/` regenerated in m14b (StatusEffect +
  BattleMonster.status); no drift against the generated snapshot.
- **battle-schema-snapshot green with status column** — `spacetime-types.json` baseline
  updated to 15 types in m14b; snapshot eval passes.
- **`resolve_full_turn` M7-regression passes** — `m14a_tests.rs` proof-of-teeth #1
  (byte-identical events to `resolve_turn` on a plain attack with empty BattleStatusStore
  and default weather) is live in the suite and green.
- **Full `just ci` EXIT=0** — all Rust tests (game-core + server-module + sim-harness),
  all client tests (vitest), and all evals pass.
- **Mutation rate within ratchet** — existing ratchet cap (ADR-0050) not violated.

---

## Decisions

### D1 — Residuals from ADR-0096 R1 and R3 advance to Phase C (not M14f)

ADR-0096 listed three residuals as "deferred to M14f":
- **R1** — `swap_active` drops enemy `StatusApplied` during swap-retaliation (no store
  built, no write-back).
- **R2** — Bench-monster status cannot be cleared mid-battle via `use_battle_item`.
- **R3** — `attempt_recruit` retaliation status gap (same event-discard pattern as R1).

m14f is doc-only (no production code). All three residuals advance to Phase C. They are
low-severity (R1/R3: rare-path; R2: bench-only, tick/expiry still correct) and carry no
data-loss or server-authoritative invariant violation. They are named follow-ups for the
first relevant Phase C slice that touches `battle.rs` / `taming.rs`.

### D2 — ARCHITECTURE.md update is targeted (M14 section only)

The ARCHITECTURE.md update in this slice adds only:
- Per-milestone narrative summaries for M14a–M14e (matching the style of M11–M13).
- A "Phase B complete" statement marking M11–M14 done and noting Phase C.

The ADR decision-paragraph at line ~261 already covers 0092–0096 (added progressively
by chore PRs). No re-statement of those entries needed.

### D3 — Spec §5 tick-boxes updated for m14d and m14e

Spec §5 had m14a–m14c ticked and m14d–m14e open. This slice ticks:
- m14d (PR #139, ADR-0095) — Weather/field state.
- m14e (PR #141, ADR-0096) — Status-curing items + client event display.
- Proof-of-teeth (distributed across m14a–m14e; all green).
- Doc-keeper task (this slice, PR-to-be-assigned, ADR-0097).

---

## M14 Slice Summary

| Slice | ADR | PR | What |
|-------|-----|----|------|
| m14a | 0092 | #134 | `StatusEffect` enum + `BattleStatusStore` (pure game-core), `resolve_full_turn` wrapper, M7-regression proof-of-teeth |
| m14b | 0093 | #135 | `StatusEffect` → `types.rs` (circular-import avoidance), `BattleMonster.status` additive column (`#[serde(default)]`), `StatusCured.slot` (RT-S14-01 fix), `StatusVariance::from_ctx_random`, `submit_attack → resolve_full_turn` |
| m14c | 0094 | #137 | `StatusKind` payload-free, `AbilityEffect` exhaustive enum, `AbilityStore`, `apply_entry_ability` / `apply_ability_modifiers`, abilities content registry, `validate_abilities` additive sibling, `CONTENT_VERSION 7→8` |
| m14d | 0095 | #139 | `WeatherKind` exhaustive enum, `WeatherEffect` with `turns_remaining`, per-turn chip damage + effectiveness modifiers, `sets_weather` on `SkillDef`, `CONTENT_VERSION 8→9` |
| m14e | 0096 | #141 | `applies_status` on `SkillDef`, `cure_status` on `ItemDef`, `use_battle_item` reducer (6-guard), Phase 1.5 store sync + Phase 4.5 apply, client status badge, `CONTENT_VERSION 9→10` |

---

## Named Residuals (Phase C carry-forwards)

| ID | Severity | Description |
|----|----------|-------------|
| RT-PS-01 | MED | `set_party_slot` race: two reducers can populate same slot (DB unique-constraint race — M13.5f) |
| RT-PS-DIALOGUE | LOW | TOCTOU in dialogue advance + party slot (M13.5f) |
| R1 (M14e) | LOW | `swap_active` drops StatusApplied on swap-retaliation turn |
| R2 (M14e) | LOW | Bench-monster status cannot be player-cured mid-battle |
| R3 (M14e) | LOW | `attempt_recruit` retaliation status gap (same as R1) |

---

## ADR next-free: 0098
