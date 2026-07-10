// render/interpolation.ts — the remote-character interpolation delay buffer
// (M4b, ADR-0013/0090). PURE. The chief fix for v1's remote stutter/rubberband.
//
// A remote character is drawn at `now - interpDelay` BETWEEN its bracketing
// authoritative snapshots. The delay is a jitter shock-absorber: brief arrival
// jitter is hidden because we render slightly in the past where bracketing snapshots
// already exist. Past the latest snapshot we HOLD — never extrapolate (extrapolation
// overshoots, then snaps back: the v1 rubberband). Before the earliest snapshot we
// clamp to it.
//
// ADR-0090 (M13.5e): the delay is now ADAPTIVE per character — derived from an EWMA
// jitter estimate so burst-delivery (two ticks in one flush) widens the window rather
// than collapsing to a zero-span jump. `interpDelayMs` is kept for backward compat.

import {
  INTERP_DELAY_STEPS,
  INTERP_JITTER_ALPHA,
  INTERP_JITTER_COEFF,
  INTERP_MAX_DELAY_STEPS,
  INTERP_MIN_DELAY_STEPS,
} from './config';

/** A positional sample stamped with local receive time (the store's `Snapshot`). */
export interface InterpSample {
  readonly tileX: number;
  readonly tileY: number;
  readonly receivedAt: number; // performance.now()
}

export interface RenderPos {
  readonly x: number; // fractional tile units (the renderer scales by TILE_PX)
  readonly y: number;
}

/** The render clock for a remote: how far in the past we sample (ms). */
export function interpDelayMs(stepMs: number): number {
  return INTERP_DELAY_STEPS * stepMs;
}

/**
 * Interpolate a remote position at `renderTime` between `prev` (older) and
 * `latest` (newer). Holds at `latest` past it (no extrapolation); clamps to
 * `prev` before it; with no `prev` yet, sits on `latest`.
 */
export function interpolate(
  prev: InterpSample | undefined,
  latest: InterpSample,
  renderTime: number,
): RenderPos {
  if (prev === undefined) return { x: latest.tileX, y: latest.tileY };
  if (renderTime >= latest.receivedAt) return { x: latest.tileX, y: latest.tileY }; // HOLD
  if (renderTime <= prev.receivedAt) return { x: prev.tileX, y: prev.tileY }; // clamp
  const span = latest.receivedAt - prev.receivedAt;
  if (span <= 0) return { x: latest.tileX, y: latest.tileY };
  const a = (renderTime - prev.receivedAt) / span;
  return {
    x: prev.tileX + (latest.tileX - prev.tileX) * a,
    y: prev.tileY + (latest.tileY - prev.tileY) * a,
  };
}

// =============================================================================
// ADR-0090 (M13.5e e-5): Adaptive interpolation — jitter estimator + functions
// Every part is commented with WHAT and WHY (Drew's rider, D-13.5-1).
// =============================================================================

/**
 * Per-character EWMA jitter estimator (ADR-0090).
 *
 * WHAT: Tracks the exponentially-weighted moving average of absolute deviation
 * of the inter-arrival interval from the nominal server step (STEP_MS).
 *
 * WHY: Burst delivery (two server ticks arriving in one WebSocket flush) makes
 * both snapshots share the same `receivedAt`, collapsing the interpolation span
 * to zero → instant position pop. This estimator detects burst patterns so the
 * adaptive delay can widen the render window to bracket the pre-burst snapshot.
 */
export class JitterEstimator {
  /** Current EWMA estimate of |interval − stepMs| in milliseconds. */
  #ewma: number;
  readonly #alpha: number;

  /**
   * @param alpha - EWMA smoothing factor (0 < α ≤ 1). Smaller = slower reaction.
   *   Default: INTERP_JITTER_ALPHA (0.125 ≈ 8-sample half-life).
   *   WHY 0.125: ignores a single late packet; reacts to a sustained bursty segment.
   */
  constructor(alpha = INTERP_JITTER_ALPHA) {
    this.#alpha = alpha;
    // Init to 0: no history → assume smooth until observations arrive.
    this.#ewma = 0;
  }

  /**
   * Update the estimate with a new observed inter-arrival interval.
   *
   * WHY `intervalMs` not `arrivalTime`: pure (no Date/performance.now calls);
   * the caller computes the delta, keeping this testable and clock-agnostic.
   *
   * @param intervalMs - Measured ms between this arrival and the previous one.
   *   A burst arrival (two in one flush) presents as intervalMs ≈ 0.
   * @param stepMs     - Nominal server step interval (the expected cadence).
   */
  update(intervalMs: number, stepMs: number): void {
    // Deviation: how far this arrival was from the expected cadence.
    // Burst (interval≈0) → deviation≈stepMs (high jitter signal).
    // Steady (interval≈stepMs) → deviation≈0 (no jitter).
    const deviation = Math.abs(intervalMs - stepMs);
    this.#ewma = this.#alpha * deviation + (1 - this.#alpha) * this.#ewma;
  }

  /** Current EWMA jitter estimate in ms. Zero when smooth or no history yet. */
  get jitterMs(): number {
    return this.#ewma;
  }
}

/**
 * Compute the adaptive interpolation delay (ms) from the current jitter estimate.
 *
 * WHAT: delay = clamp(base + JITTER_COEFF×jitter, MIN_DELAY, MAX_DELAY),
 * where base = 1.0×stepMs (the ADR-0075 fixed value on a smooth network).
 *
 * WHY: The render window must span at least one step so a prior snapshot always
 * brackets it. Extra jitter headroom widens the window during bursts. The upper
 * clamp limits remote-entity lag on bad connections (lag > pops for user experience).
 */
export function adaptiveInterpDelayMs(jitterMs: number, stepMs: number): number {
  const base = stepMs; // 1.0× base — no added latency when jitter is zero
  const raw = base + INTERP_JITTER_COEFF * jitterMs;
  const min = INTERP_MIN_DELAY_STEPS * stepMs;
  const max = INTERP_MAX_DELAY_STEPS * stepMs;
  return Math.max(min, Math.min(max, raw));
}

/**
 * Interpolate a remote position across a variable-depth snapshot history.
 *
 * WHAT: Search the history (oldest-first, index 0 = oldest) for the tightest
 * bracket around `renderTime`: prev = last snap with receivedAt ≤ renderTime,
 * next = first snap with receivedAt > renderTime. Lerp within the bracket;
 * HOLD at newest past it; clamp to oldest before it.
 *
 * WHY over `interpolate(prev, latest, t)`: the 2-argument form can only use the
 * last two snapshots. With deeper history, the genuine pre-burst snapshot (earlier
 * `receivedAt`) is available as the lower bracket — enabling smooth interpolation
 * even when the two burst snapshots share the same `receivedAt`.
 *
 * Same-receivedAt tiebreak: when both burst co-arrivals carry `receivedAt ≤ renderTime`,
 * the HOLD path (`renderTime >= newest`) fires and returns the latest position — this is
 * the primary graceful degradation for unmitigated bursts. The internal `span ≤ 0` guard
 * handles the degenerate case where two snapshots share a timestamp that is neither
 * at/past newest nor at/before oldest (theoretically impossible with a valid sorted ring
 * but retained as a defensive check against future invariant violations).
 *
 * @param snapshots  - Ordered oldest-first; must have ≥ 1 entry.
 * @param renderTime - Target render clock (ms), typically now − adaptive delay.
 */
export function interpolateHistory(
  snapshots: readonly InterpSample[],
  renderTime: number,
): RenderPos {
  // Degenerate: no history — no position to render.
  if (snapshots.length === 0) return { x: 0, y: 0 };
  if (snapshots.length === 1) {
    const only = snapshots[0]!;
    return { x: only.tileX, y: only.tileY };
  }

  const newest = snapshots[snapshots.length - 1]!;
  // HOLD past the newest snapshot (no extrapolation — same contract as interpolate).
  // WHY: extrapolation overshoots and then snaps back when the next snapshot arrives
  // (the v1 rubberband). HOLD is the correct degradation when we're ahead of the buffer.
  if (renderTime >= newest.receivedAt) return { x: newest.tileX, y: newest.tileY };

  const oldest = snapshots[0]!;
  // Clamp to oldest before the earliest snapshot (no backward extrapolation).
  if (renderTime <= oldest.receivedAt) return { x: oldest.tileX, y: oldest.tileY };

  // Linear scan to find the tightest bracket (snapshots array is small; ≤ INTERP_MAX_DEPTH=4).
  // prev = last snapshot with receivedAt ≤ renderTime (advance as we go).
  // next = first snapshot with receivedAt > renderTime (stop on first match).
  let prev = oldest;
  let next = newest;
  for (let i = 1; i < snapshots.length; i++) {
    const s = snapshots[i]!;
    if (s.receivedAt <= renderTime) {
      prev = s; // still at or before renderTime → advance the lower bound
    } else {
      next = s; // first snapshot strictly after renderTime → bracket locked
      break;
    }
  }

  const span = next.receivedAt - prev.receivedAt;
  // Degenerate guard: span ≤ 0 can only occur when two snapshots in the ring buffer
  // have identical receivedAt AND that timestamp is strictly between oldest and newest
  // (i.e. it didn't trigger the HOLD or clamp paths above). In practice this cannot
  // happen with a valid oldest-first array — the HOLD path (renderTime >= newest) fires
  // first for same-receivedAt bursts at renderTime. The guard is retained as a defensive
  // check against future ring-buffer invariant violations. Holds at `next`.
  if (span <= 0) return { x: next.tileX, y: next.tileY };

  const a = (renderTime - prev.receivedAt) / span;
  return {
    x: prev.tileX + (next.tileX - prev.tileX) * a,
    y: prev.tileY + (next.tileY - prev.tileY) * a,
  };
}
