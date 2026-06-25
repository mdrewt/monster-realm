// render/interpolation.ts — the remote-character interpolation delay buffer
// (M4b, ADR-0013). PURE. The chief fix for v1's remote stutter/rubberband.
//
// A remote character is drawn at `now - interpDelay` BETWEEN its two latest
// authoritative snapshots (the store keeps exactly the last two). The delay is a
// jitter shock-absorber: brief arrival jitter is hidden because we render slightly
// in the past where both bracketing snapshots already exist. Past the latest
// snapshot we HOLD — never extrapolate (extrapolation overshoots, then snaps back:
// the v1 rubberband). Before the earlier snapshot we clamp to it.

import { INTERP_DELAY_STEPS } from './config';

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
