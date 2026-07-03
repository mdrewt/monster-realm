// render/interpolation.ts behaviour suite (M4b, ADR-0013) — vitest.
// SOURCE OF TRUTH: M4-frontend.spec.md §3 "Rendering" + "Smoothness evals":
// remote drawn at now - interpDelay between the two bracketing snapshots; HOLD
// (never extrapolate) past the latest; "remote interpolation no jump > one tile
// under sub-buffer jitter; a remote renderer WITHOUT the buffer fails the jitter
// test" (proof-of-teeth, ADR-0010).
import { describe, expect, it } from 'vitest';
import { type InterpSample, interpDelayMs, interpolate } from './interpolation';

const s = (tileX: number, tileY: number, receivedAt: number): InterpSample => ({
  tileX,
  tileY,
  receivedAt,
});

describe('interpDelayMs: the buffer is sized in STEP_MS multiples (ADR-0013)', () => {
  it('renders remotes 1.0 STEP_MS in the past to absorb jitter without hold/jump (ADR-0013, M12.5d-1)', () => {
    expect(interpDelayMs(200)).toBe(200); // 1.0 * 200 (M12.5d-1 fix: was 1.5)
    expect(interpDelayMs(100)).toBe(100); // 1.0 * 100
    expect(interpDelayMs(200)).toBeGreaterThan(0); // strictly in the past
  });
});

describe('interpolate: bracket / hold / clamp', () => {
  it('with no prev snapshot, sits on latest', () => {
    expect(interpolate(undefined, s(3, 4, 1000), 1234)).toEqual({ x: 3, y: 4 });
  });

  it('lerps linearly between prev and latest', () => {
    const p = interpolate(s(0, 0, 0), s(1, 0, 200), 100);
    expect(p.x).toBeCloseTo(0.5);
    expect(p.y).toBeCloseTo(0);
  });

  it('BITES: HOLDS at latest past it (never extrapolates / overshoots)', () => {
    // An extrapolating impl would return x > 1 here (the v1 rubberband). We hold.
    const held = interpolate(s(0, 0, 0), s(1, 0, 200), 400);
    expect(held).toEqual({ x: 1, y: 0 });
  });

  it('clamps to prev before the earlier snapshot', () => {
    expect(interpolate(s(2, 2, 1000), s(3, 2, 1200), 500)).toEqual({ x: 2, y: 2 });
  });

  it('degenerate equal timestamps resolve to latest (no divide-by-zero)', () => {
    expect(interpolate(s(0, 0, 500), s(9, 9, 500), 500)).toEqual({ x: 9, y: 9 });
  });
});

// --- proof-of-teeth: buffered <= 1 tile/frame; unbuffered double-jumps ----------
//
// A deterministic SUB-buffer jitter stream (every arrival within interpDelay of
// its logical step time) that compresses two arrivals into one frame interval —
// the case that makes a no-buffer renderer (draw the latest snapshot directly)
// leap two tiles in a single frame, while the delay buffer keeps every per-frame
// step <= one tile.
interface Arrival {
  readonly tileX: number;
  readonly at: number;
}

function maxFrameJump(
  arrivals: readonly Arrival[],
  frames: readonly number[],
  render: (prev: InterpSample | undefined, latest: InterpSample, t: number) => number,
): number {
  let prev: InterpSample | undefined;
  let latest: InterpSample | undefined;
  let cursor = 0;
  let last: number | undefined;
  let worst = 0;
  for (const f of frames) {
    while (cursor < arrivals.length && arrivals[cursor].at <= f) {
      const a = arrivals[cursor++];
      prev = latest;
      latest = s(a.tileX, 0, a.at);
    }
    if (latest === undefined) continue;
    const x = render(prev, latest, f);
    if (last !== undefined) worst = Math.max(worst, Math.abs(x - last));
    last = x;
  }
  return worst;
}

describe('interpolation proof-of-teeth (ADR-0010): the buffer is load-bearing', () => {
  const INTERP_DELAY = interpDelayMs(200); // production delay — 1.0 × STEP_MS(200) = 200ms
  // logical steps x=0,1,2 at t=0,200,400; arrivals x=1 at 290 and x=2 at 300 arrive in the
  // same 100ms frame window — the delay buffer pushes renderTime before both at that frame.
  const arrivals: Arrival[] = [
    { tileX: 0, at: 0 },
    { tileX: 1, at: 290 },
    { tileX: 2, at: 300 },
  ];
  const frames = Array.from({ length: 9 }, (_, i) => i * 100); // 0..800 every 100ms

  it('the delay buffer keeps every per-frame step <= one tile', () => {
    const jump = maxFrameJump(arrivals, frames, (p, l, t) => interpolate(p, l, t - INTERP_DELAY).x);
    expect(jump).toBeLessThanOrEqual(1);
  });

  it('BITES: the no-buffer renderer (latest only) leaps > one tile in a frame', () => {
    const jump = maxFrameJump(arrivals, frames, (_p, l) => l.tileX);
    expect(jump).toBeGreaterThan(1); // 0 -> 2 across one frame: the test bites
  });
});

// =============================================================================
// M12.5d-1: INTERP_DELAY_STEPS=1.0 — monotone positions under steady 200ms cadence
// SOURCE OF TRUTH: M12.5d spec §1 "Smoothness: remote interpolation hold/jump fix"
//
// RED REASON (before impl): INTERP_DELAY_STEPS is currently 1.5, so interpDelayMs(200)
// returns 300. With a 300ms delay and 200ms cadence, renderTime=now-300 falls BEFORE
// the prev snapshot for 100ms after each latest arrival → 100ms hold → ramp to 50%
// → new update → snap to new prev. Result: non-monotone position sequence (hold/jump).
// After fix: INTERP_DELAY_STEPS=1.0 → delay=200ms matches cadence → monotone.
// =============================================================================

describe('interpolation D1: INTERP_DELAY_STEPS=1.0 produces monotone positions under steady 200ms cadence', () => {
  it('BITES (M12.5d-1): with delay=1.0*stepMs and steady 200ms cadence, positions are monotone (no hold/jump)', () => {
    // Evidence: INTERP_DELAY_STEPS=1.5 with 2 snapshots causes a hold/jump cycle.
    // Root cause: renderTime=now-300ms falls before prev snapshot for 100ms after
    // latest arrives → 100ms hold → ramp to 50% → new update → snap to new prev.
    // Fix: INTERP_DELAY_STEPS=1.0 → renderTime=now-200ms smoothly matches 200ms cadence.
    //
    // Setup: remote player moved from (0,0) to (1,0) at T=200, then (2,0) at T=400.
    // With INTERP_DELAY=200ms, renderTime=now-200.
    // We sample positions at client-now = 201, 300, 399, 400, 401, 500, 599, 600.
    // Expected: each sample's x-position >= previous (monotone, no holds or jumps).
    //
    // This test will be RED until INTERP_DELAY_STEPS changes to 1.0.
    // (interpDelayMs(200) currently returns 300; after fix it returns 200.)

    const STEP_MS = 200;
    const delay = interpDelayMs(STEP_MS); // after fix: 200, currently 300

    // segment 1: from (0,0) at T=0 to (1,0) at T=200
    const prev1 = s(0, 0, 0);
    const latest1 = s(1, 0, 200);

    // segment 2: from (1,0) at T=200 to (2,0) at T=400
    const prev2 = s(1, 0, 200);
    const latest2 = s(2, 0, 400);

    // Sample at various client-now values using the correct delay
    function sample(clientNow: number): number {
      const renderTime = clientNow - delay;
      // Use segment 1 before T+400 arrives, segment 2 after
      if (clientNow < 400) {
        return interpolate(prev1, latest1, renderTime).x;
      }
      return interpolate(prev2, latest2, renderTime).x;
    }

    // Sample sequence: should be monotone increasing
    const clientNows = [201, 250, 300, 350, 399, 400, 450, 500, 550, 599, 600];
    const positions = clientNows.map(sample);

    // Monotone check: each position >= previous
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1] - 0.001); // tiny epsilon for float
    }

    // Positions must reach at least 1.0 before segment 2 starts (by T+400)
    const posAt399 = sample(399);
    expect(posAt399).toBeGreaterThanOrEqual(0.9); // nearly at tile 1 before transition
    // After segment 2 starts, positions should advance toward tile 2
    const posAt600 = sample(600);
    expect(posAt600).toBeGreaterThanOrEqual(1.5); // well into second segment
  });

  it('BITES (M12.5d-1): interpDelayMs(200) equals 1.0 * 200 = 200 after the fix', () => {
    // This test is RED with the current code (returns 300 = 1.5*200).
    // After fix: returns 200 = 1.0*200.
    expect(interpDelayMs(200)).toBe(200);
  });
});
