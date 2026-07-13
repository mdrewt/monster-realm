# 0041. Integer-only damage formula with injected variance

**Status:** Accepted
**Date:** 2026-06-26
**Slice:** m7a
**Supersedes:** —
**Amends:** —
**Subsystems:** battle
**Decision:** Integer-only damage formula with u64 intermediates, STAB, type effectiveness, and a seeded ±15% variance roll for cross-platform determinism.
**Amended-by:** ADR-0092

- Status: accepted
- Date: 2026-06-26

## Context and problem statement

The combat engine needs a damage formula that is deterministic across native
and wasm targets. Floating-point arithmetic can diverge between platforms
(different rounding, fused multiply-add, etc.), breaking the functional-core
SSOT guarantee (ADR-0003). The formula must also support STAB, type
effectiveness, and a variance roll — all without floats.

## Considered alternatives
- Option A — **Float formula, round at the end** — simple to write but
  non-deterministic across targets; violates the clippy float ban.
- Option B — **Integer-only with u32 intermediates, truncating division,
  multiplier fractions expressed as integer ratios** (chosen).

## Decision outcome
- Chosen: Option B, because it is mechanically enforced (clippy bans floats
  workspace-wide), produces bit-identical results on native and wasm, and
  follows the same pattern as the stat derivation in `monster/rules.rs`.
- Formula: `base = (2*level/5+2)*power*attack/defense/50+2`, then
  STAB `*3/2` if skill affinity matches attacker, then type `*eff/10`,
  then variance `*roll/100`, then `max(1)`, clamped to `u16::MAX`.
- Type effectiveness is data-driven (RON `type_chart.ron`), with raw values
  in {0, 5, 10, 20} enforced by `validate_content`.
- Variance (85..=100) and accuracy (0..=99) are injected via `TurnVariance`,
  keeping the resolver a pure function of `(state, choices, variance)`.
- Consequences: integer truncation means damage is slightly lower than a
  float formula on some inputs (accepted — matches Pokemon's approach);
  extreme stat combinations can overflow u32 intermediates only if stats
  exceed u16::MAX, which is structurally prevented by the type system.
  **(Superseded — see the M8.5e amendment below: the intermediates are `u64`,
  and this overflow rationale is corrected.)**

## Amendment (M8.5e, 2026-06-27): u64 intermediates — correction

A documentation-accuracy review (M8.5e) found that the original decision text
above understates the intermediate width and gives an incorrect overflow
rationale. The implementation was correct; the ADR text lagged it.

- **Intermediate width is `u64`, not `u32`.** The shipped `calc_damage`
  (`game-core/src/combat/damage.rs`) casts every operand with `u64::from(...)`
  and computes all intermediates in `u64` (module doc-comment: "All arithmetic
  uses `u64` intermediates to avoid overflow"). The original "u32 intermediates"
  was never what the code did.
- **The original "can't overflow u32" rationale was wrong.** The formula
  evaluates the product `(2*level/5+2)*power*attack` *before* any division. With
  the leading factor `(2*level/5+2)` at least 2 for every level, this three-term
  product exceeds `u32::MAX`: even at the minimum factor of 2, `2 * power *
  attack` with operands near `u16::MAX` reaches `2 × 65535² ≈ 8.59 × 10⁹`,
  beyond `u32::MAX` (`4.29 × 10⁹`). For reference, the two-term `power × attack`
  is `65535² = 4,294,836,225`, sitting just under `u32::MAX` `4,294,967,295`
  (only ~131k of headroom) — so the leading level factor pushes it past the
  `u32` ceiling. `u64` intermediates are therefore required, exactly as the code
  already does.
- **No code change.** This amendment corrects documentation only; the original
  "Considered alternatives" and "Decision outcome" sections are preserved as the
  historical record.
