// shared/interpConfig.ts — interpolation constants shared across net and render layers.
//
// WHY a shared module: net/store.ts needs INTERP_MAX_DEPTH, BURST_EPSILON_MS,
// INTERP_JITTER_ALPHA and JITTER_IDLE_GAP_STEPS for upsertCharacter burst detection + jitter
// EWMA. render/ needs the first three for adaptiveInterpDelayMs and the documentary header,
// and the fourth as the remote walk-continuation window.
// A net→render or render→net import would violate layer separation; this shared
// module (no layer affiliation) keeps the constants SSOT without a cycle.

/** EWMA smoothing factor for the per-character jitter estimator.
 *  WHAT: α in `ewma = α×|interval−stepMs| + (1−α)×ewma`.
 *  WHY 0.125: ~8-sample effective half-life — slow enough to ignore a single
 *  late packet, fast enough to react to a sustained bursty segment. */
export const INTERP_JITTER_ALPHA = 0.125;

/** Maximum snapshot history depth per remote character.
 *  WHAT: ring-buffer cap in AuthoritativeStore.upsertCharacter.
 *  WHY 4: 2.5× max delay / 1.0× step = 2.5 steps back + 1 headroom ≈ 4 snapshots.
 *  Deeper history keeps pre-burst snapshots alive for interpolateHistory bracket. */
export const INTERP_MAX_DEPTH = 4;

/** Burst-detection epsilon in ms.
 *  WHAT: if two upsertCharacter calls for the same entity arrive within this
 *  window of each other, they are treated as a single burst flush.
 *  WHY 20: the SDK delivers same-transaction rows synchronously (< 1 ms apart
 *  in practice); 20 ms provides ample margin without catching normal slow packets. */
export const BURST_EPSILON_MS = 20;

/** The idleness threshold, in STEP_MS multiples.
 *  WHAT: an interval between two position changes longer than this is the character standing,
 *  not delivery jitter. `upsertCharacter` takes no jitter sample from such an interval
 *  (`<=` admits, `>` skips; a burst co-arrival near 0 still counts), and the renderer stops
 *  treating a remote as walking once its newest position change is this old.
 *  WHY 3: must exceed 2 — a coalesced-tick spike presents as interval ≈ 2×stepMs of
 *  genuine delivery jitter that must stay inside the gate — while capping one admitted
 *  sample's delay movement at +0.5 steps. */
export const JITTER_IDLE_GAP_STEPS = 3;
