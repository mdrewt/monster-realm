// input/longPress.ts — the touch long-press as a pure tracker (ctl-15, CTL15.3). A press that stays
// within 10 px of where it started for 500 ms fires once (the pointer source presses B); its end
// tells the source whether the browser's trailing click must be swallowed. No DOM and no clock:
// the source owns the timer and hands the times in.

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;

/** One finger's press: where and when it started, and whether it has fired. */
export interface PressTrack {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly t0: number;
  readonly fired: boolean;
}

export function startPress(id: number, x: number, y: number, t: number): PressTrack {
  return { id, x, y, t0: t, fired: false };
}

/** A move of finger `id`: beyond the slop from the START the press is cancelled (null). */
export function movePress(
  track: PressTrack | null,
  id: number,
  x: number,
  y: number,
): PressTrack | null {
  if (track === null || track.id !== id) return track;
  const dx = x - track.x;
  const dy = y - track.y;
  return dx * dx + dy * dy > LONG_PRESS_SLOP_PX * LONG_PRESS_SLOP_PX ? null : track;
}

/** The timer's check at time `t`: fires exactly once, at LONG_PRESS_MS or later. */
export function firePress(
  track: PressTrack | null,
  t: number,
): { track: PressTrack | null; fire: boolean } {
  if (track === null || track.fired || t - track.t0 < LONG_PRESS_MS) return { track, fire: false };
  return { track: { ...track, fired: true }, fire: true };
}

/** Finger `id` lifted (or was cancelled): a press that fired swallows its trailing click. */
export function endPress(
  track: PressTrack | null,
  id: number,
): { track: PressTrack | null; swallowClick: boolean } {
  if (track === null || track.id !== id) return { track, swallowClick: false };
  return { track: null, swallowClick: track.fired };
}
