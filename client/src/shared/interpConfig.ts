// shared/interpConfig.ts — interpolation constants shared across net and render layers.
//
// WHY a shared module: net/store.ts needs INTERP_MAX_DEPTH, BURST_EPSILON_MS, and
// INTERP_JITTER_ALPHA for upsertCharacter burst detection + jitter EWMA. render/config.ts
// needs the same three constants for adaptiveInterpDelayMs and the documentary header.
// A net→render or render→net import would violate ADR-0014 layer separation; this shared
// module (no layer affiliation) keeps the constants SSOT without a cycle (ADR-0090).

/** EWMA smoothing factor for the per-character jitter estimator (ADR-0090).
 *  WHAT: α in `ewma = α×|interval−stepMs| + (1−α)×ewma`.
 *  WHY 0.125: ~8-sample effective half-life — slow enough to ignore a single
 *  late packet, fast enough to react to a sustained bursty segment. */
export const INTERP_JITTER_ALPHA = 0.125;

/** Maximum snapshot history depth per remote character (ADR-0090).
 *  WHAT: ring-buffer cap in AuthoritativeStore.upsertCharacter.
 *  WHY 4: 2.5× max delay / 1.0× step = 2.5 steps back + 1 headroom ≈ 4 snapshots.
 *  Deeper history keeps pre-burst snapshots alive for interpolateHistory bracket. */
export const INTERP_MAX_DEPTH = 4;

/** Burst-detection epsilon in ms (ADR-0090).
 *  WHAT: if two upsertCharacter calls for the same entity arrive within this
 *  window of each other, they are treated as a single burst flush.
 *  WHY 20: the SDK delivers same-transaction rows synchronously (< 1 ms apart
 *  in practice); 20 ms provides ample margin without catching normal slow packets. */
export const BURST_EPSILON_MS = 20;
