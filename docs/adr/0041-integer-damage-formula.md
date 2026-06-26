# 0041. Integer-only damage formula with injected variance
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
