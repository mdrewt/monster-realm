---
name: netcode-smoothness
description: Working on client prediction, reconciliation, movement, or rendering in the SpacetimeDB game — anything that could reintroduce v1's desync, stutter, skipping-ahead, or rubberbanding. Encodes ADR-0013 and netcode-quality-review.md.
---

# Netcode smoothness (anti desync / stutter / skip / rubberband)

> Single source of truth: `docs/adr/0013-*` and `netcode-quality-review.md`. This skill is the working summary — read those before changing the reconcile path.

## Spine (do not violate)

- **Rules live once in `game-core`; server is authoritative.** Predict **movement only** — battles are server-resolved. No second rule implementation on the client.
- **Integer-tile authority + determinism.** Clocks/RNG are **injected** (enforced by `clippy.toml`). `apply_move` is a **total** function — an illegal move is a legal **no-op** (a bump), never an error or a desync.

## The four root-cause fixes (each maps to a v1 symptom)

1. **Rubberband ← reconciling a half-applied batch.** Reconcile only on a **complete per-transaction snapshot** (`onApplied` / the per-transaction batch hook), never mid-batch. The 4-step reconcile: (a) drop acked ops, (b) rebuild from the server `move_queue` + replay unacked queue-ops, (c) reset to the rebased baseline, (d) re-drain. It must be **atomic** against one transaction.
2. **Stutter ← snapping own-character to every server tick.** Run a **decoupled own-character slide clock** — interpolate the local avatar smoothly instead of hard-setting position per tick.
3. **Skipping/teleport on remotes ← rendering at head.** Render remote entities through an **interpolation delay buffer** (a render slightly in the past), so packets smooth out.
4. **Divergence blowups ← unbounded prediction.** Use **bounded prediction with snap-on-gap**: cap how far prediction may run ahead; on a gap beyond the bound, snap to the authoritative state (a small visible correction beats an accelerating desync). No clock-sync / rebase-time assumptions.

## Mechanical gates (every change here ships them)

- **Prediction-parity eval** — the native (`game-core`) rule and the `wasm-pack` build produce **identical** results for the same integer input.
- **Netcode-smoothness eval** — assert divergence/reconcile rates stay within budget under simulated latency/jitter.
- **Proof-of-teeth fixture** — a known **half-applied / out-of-order batch** the reconcile must handle without rubberbanding; it must *fail* if someone reconciles mid-batch.

## Red flags in a diff (reject)

Reconciling outside the per-transaction snapshot · per-tick position snapping on the local avatar · rendering remotes at head (no delay buffer) · predicting battle outcomes · unbounded prediction with no snap · reading wall-clock/`rand` instead of injected clock/RNG.

## Gotchas

_Living log — runtime edge cases, bugs, quirks found while building netcode. Per entry: **symptom** → cause → **avoid:** action. (The §"Red flags" list above is the static review checklist; record *observed* quirks here.)_

- **Rubberbanding on movement** → reconciling a half-applied transaction batch. **Avoid:** reconcile only on the complete `onApplied` per-transaction snapshot.
- **Local avatar stutters** → snapping position to every server tick. **Avoid:** decoupled slide clock (interpolate the local avatar).
- **Remote players teleport / skip** → rendering remotes at head. **Avoid:** interpolation delay buffer (render slightly in the past).
- **Desync accelerates instead of correcting** → unbounded prediction. **Avoid:** bounded prediction + snap-on-gap.
- **Historical note:** v1 felt bad despite clean, correct code — the cause was *feel* (the four above), not logic bugs. Treat smoothness as its own gated property, not a side effect of correctness.
