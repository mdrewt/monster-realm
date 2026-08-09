// observability/frameWindow.ts — m20c (ADR-0180 body amendment), OBS-25.
//
// A 1-second frame accumulator with an INJECTED clock (the rAF body already computes
// `performance.now()` once per frame and hands it in — this module never reads a clock).
//
// Semantics (pinned by the sibling test):
//   each tick: dt = nowMs − lastTickMs; frames += 1; maxFrameMs = max(maxFrameMs, dt).
//   with elapsed = nowMs − windowStartMs:
//     elapsed <  1000 ………………… keep accumulating, no sample;
//     1000 ≤ elapsed ≤ 2000 …… EMIT { fps: frames × 1000 / elapsed, maxFrameMs } and reset;
//     elapsed >  2000 ………………… DISCARD (AM14): reset with NO sample. rAF stops in a hidden tab;
//                              the "3 frames in 45s" window it produces on return is an
//                              alt-tab artifact, not a frame rate, and reporting it would make
//                              the OBS-25 p50 a function of how often players switch tabs.
//
// The accumulator is MUTATED in place and the non-boundary path returns the same state object:
// this runs 60×/s in the hottest loop the client has, and per-frame copy-on-write would mint
// exactly the GC pressure the frame-time metric exists to measure.

export const FRAME_WINDOW_MS = 1000;
export const FRAME_WINDOW_DISCARD_MS = 2000;

export interface FrameSample {
  readonly fps: number;
  readonly maxFrameMs: number;
}

export interface FrameWindowState {
  windowStartMs: number;
  lastTickMs: number;
  frames: number;
  maxFrameMs: number;
}

export interface FrameTickResult {
  readonly state: FrameWindowState;
  readonly sample: FrameSample | undefined;
}

/** Seeded from the injected clock — a zero seed would make the first real window look ancient
 *  and get discarded, swallowing the wasm-warm frames of every session. */
export function createFrameWindow(nowMs: number): FrameWindowState {
  return { windowStartMs: nowMs, lastTickMs: nowMs, frames: 0, maxFrameMs: 0 };
}

export function frameTick(state: FrameWindowState, nowMs: number): FrameTickResult {
  const dt = nowMs - state.lastTickMs;
  state.lastTickMs = nowMs;
  state.frames += 1;
  if (dt > state.maxFrameMs) state.maxFrameMs = dt;

  const elapsed = nowMs - state.windowStartMs;
  if (elapsed < FRAME_WINDOW_MS) {
    return { state, sample: undefined };
  }

  const sample =
    elapsed > FRAME_WINDOW_DISCARD_MS
      ? undefined // AM14: tab-suspend artifact — reset without reporting
      : { fps: (state.frames * 1000) / elapsed, maxFrameMs: state.maxFrameMs };

  state.windowStartMs = nowMs;
  state.frames = 0;
  state.maxFrameMs = 0;
  return { state, sample };
}
