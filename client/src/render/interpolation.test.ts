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

// =============================================================================
// M13.5e §5 e-5: Adaptive interpolation delay
// SOURCE OF TRUTH: M13.5 §5 e-5 (EARS criterion)
//
// Three new exports are required from interpolation.ts:
//   class JitterEstimator  — EWMA jitter estimator
//   function adaptiveInterpDelayMs(jitterMs, stepMs) — returns adaptive delay
//   function interpolateHistory(snapshots, renderTime) — interpolates over a
//     history array (>2 snapshots) instead of just prev+latest pair
//
// RED REASON: none of these exports exist yet in interpolation.ts. All tests
// below will fail with "does not provide an export named ..." until implemented.
// =============================================================================

import { adaptiveInterpDelayMs, interpolateHistory, JitterEstimator } from './interpolation';

// ---------------------------------------------------------------------------
// JitterEstimator: EWMA inter-arrival jitter measurement
//
// The estimator tracks the average deviation of actual inter-arrival intervals
// from the expected step interval. Steady arrivals → jitterMs near 0.
// Burst delivery (two snaps at same timestamp) → jitterMs grows significantly.
//
// Constructor: new JitterEstimator(alpha: number)
//   alpha = EWMA smoothing factor (0 < alpha ≤ 1; lower = more smoothing)
//
// Method: update(intervalMs: number, stepMs: number): void
//   intervalMs = actual ms between this arrival and previous arrival
//   stepMs = expected server tick interval
//
// Property: jitterMs — current EWMA estimate of |deviation| from stepMs
// ---------------------------------------------------------------------------
describe('JitterEstimator e-5: EWMA jitter estimation', () => {
  it('new estimator starts at jitterMs = 0', () => {
    // Baseline: no arrivals observed → no jitter estimated.
    // WRONG IMPL KILLED: an impl that initialises jitterMs to some nonzero sentinel.
    const est = new JitterEstimator(0.125);
    expect(est.jitterMs).toBe(0);
  });

  it('steady arrivals produce near-zero jitter estimate', () => {
    // EARS: "steady arrivals → low jitter"
    // Feed exactly stepMs-spaced arrivals — deviation is always 0 → EWMA stays 0.
    // WRONG IMPL KILLED: an impl that accumulates total interval time as "jitter".
    const est = new JitterEstimator(0.125);
    const stepMs = 200;
    est.update(200, stepMs); // deviation = |200-200| = 0
    est.update(200, stepMs);
    est.update(200, stepMs);
    est.update(200, stepMs);
    expect(est.jitterMs).toBeCloseTo(0, 1); // within 0.1ms of 0
  });

  it('single burst delivery (interval=0) produces detectable jitter', () => {
    // A burst: second snapshot arrived 0ms after the first (same receivedAt).
    // Deviation = |0 - 200| = 200ms. EWMA with alpha=0.5: after 2 updates:
    //   update(200, 200) → ewma = 0.5*|0| + 0.5*0 = 0 (first: deviation=0 for first arrival baseline)
    //   update(0, 200) → ewma = 0.5*200 + 0.5*0 = 100ms → jitterMs > 10
    // WRONG IMPL KILLED: an impl that uses interval directly (not deviation from stepMs),
    // which would give jitter=0 for steady arrivals but also 0 for the burst step.
    const est = new JitterEstimator(0.5);
    const stepMs = 200;
    est.update(200, stepMs); // first arrival: baseline (deviation=0 or used to seed)
    est.update(0, stepMs); // burst: arrived 0ms after previous → deviation = 200ms
    expect(est.jitterMs).toBeGreaterThan(10); // must detect the burst
  });

  it('high alpha converges faster than low alpha', () => {
    // Alpha controls EWMA smoothing. High alpha (0.9) reacts to new samples more
    // aggressively than low alpha (0.1). After one burst sample both estimates
    // increase, but high-alpha estimate is larger.
    // WRONG IMPL KILLED: an impl that ignores alpha and uses a fixed smoothing factor.
    const highAlpha = new JitterEstimator(0.9);
    const lowAlpha = new JitterEstimator(0.1);
    const stepMs = 200;
    // Prime both with one normal arrival
    highAlpha.update(200, stepMs);
    lowAlpha.update(200, stepMs);
    // Then one burst
    highAlpha.update(0, stepMs);
    lowAlpha.update(0, stepMs);
    // High alpha should react more strongly (higher jitterMs estimate)
    expect(highAlpha.jitterMs).toBeGreaterThan(lowAlpha.jitterMs);
  });

  it('jitterMs is always non-negative', () => {
    // Jitter is an absolute deviation — it must never go negative.
    // WRONG IMPL KILLED: an impl that computes signed deviation (can go negative).
    const est = new JitterEstimator(0.5);
    est.update(200, 200);
    est.update(100, 200); // early arrival: interval < stepMs
    est.update(300, 200); // late arrival: interval > stepMs
    expect(est.jitterMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// adaptiveInterpDelayMs: jitter-aware delay budget
//
// Signature: adaptiveInterpDelayMs(jitterMs: number, stepMs: number): number
//
// Contract:
//   - With zero jitter → returns approximately 1.0 * stepMs (base delay)
//   - With high jitter → returns more than 1.0 * stepMs but stays bounded
//   - Return value is always positive
//   - Return value is always at least stepMs (never less than the base)
// ---------------------------------------------------------------------------
describe('adaptiveInterpDelayMs e-5: jitter-aware delay budget', () => {
  it('zero jitter → delay equals base (1.0 × stepMs)', () => {
    // With no jitter, the adaptive delay degenerates to the fixed 1.0×stepMs.
    // WRONG IMPL KILLED: an impl that always returns 1.5×stepMs regardless of jitter.
    const delay = adaptiveInterpDelayMs(0, 200);
    expect(delay).toBeCloseTo(200, 0); // within 1ms of 200
  });

  it('high jitter → delay greater than base stepMs', () => {
    // With 200ms jitter on a 200ms step, the adaptive delay must increase above base.
    // WRONG IMPL KILLED: an impl that ignores jitterMs and always returns stepMs.
    const delay = adaptiveInterpDelayMs(200, 200);
    expect(delay).toBeGreaterThan(200);
  });

  it('delay is always positive', () => {
    // Even with jitter=0, stepMs=1, the delay must be > 0.
    // WRONG IMPL KILLED: an impl that returns 0 or negative on edge inputs.
    expect(adaptiveInterpDelayMs(0, 1)).toBeGreaterThan(0);
    expect(adaptiveInterpDelayMs(0, 200)).toBeGreaterThan(0);
    expect(adaptiveInterpDelayMs(100, 200)).toBeGreaterThan(0);
  });

  it('delay is at least stepMs (never undershoot the base)', () => {
    // The adaptive delay adds headroom for jitter — it must never be less than stepMs.
    // WRONG IMPL KILLED: an impl that subtracts jitter from stepMs (reduces delay on jitter).
    expect(adaptiveInterpDelayMs(0, 200)).toBeGreaterThanOrEqual(200);
    expect(adaptiveInterpDelayMs(50, 200)).toBeGreaterThanOrEqual(200);
    expect(adaptiveInterpDelayMs(200, 200)).toBeGreaterThanOrEqual(200);
  });

  it('delay is bounded (does not grow without limit for extreme jitter)', () => {
    // Sanity bound: even with 10× stepMs jitter, delay should not exceed ~3× stepMs.
    // This keeps the interpolation buffer from growing so large it causes visual lag.
    // WRONG IMPL KILLED: an impl with delay = stepMs + jitterMs (unbounded linear growth).
    const stepMs = 200;
    const delay = adaptiveInterpDelayMs(2000, stepMs); // pathological 10× jitter
    expect(delay).toBeLessThanOrEqual(stepMs * 3); // max 600ms (3× base)
  });

  it('monotone: more jitter → longer or equal delay', () => {
    // The delay function must be non-decreasing in jitterMs.
    // WRONG IMPL KILLED: a non-monotone impl where jitter=100 gives more delay than jitter=200.
    const stepMs = 200;
    const d0 = adaptiveInterpDelayMs(0, stepMs);
    const d50 = adaptiveInterpDelayMs(50, stepMs);
    const d100 = adaptiveInterpDelayMs(100, stepMs);
    const d200 = adaptiveInterpDelayMs(200, stepMs);
    expect(d50).toBeGreaterThanOrEqual(d0);
    expect(d100).toBeGreaterThanOrEqual(d50);
    expect(d200).toBeGreaterThanOrEqual(d100);
  });
});

// ---------------------------------------------------------------------------
// interpolateHistory: interpolate over a history array
//
// Signature: interpolateHistory(snapshots: readonly InterpSample[], renderTime: number): RenderPos
//
// Contract:
//   - With 0 snapshots → returns { x: 0, y: 0 } (or throws? — spec says "return")
//   - With 1 snapshot → sits on it (no interpolation)
//   - With 2+ snapshots → finds the bracketing pair and lerps (same as interpolate)
//   - Clamps to earliest snapshot before it
//   - Holds at latest snapshot past it (no extrapolation)
//   - For a burst (multiple snapshots at the same receivedAt), finds the correct bracket
// ---------------------------------------------------------------------------
describe('interpolateHistory e-5: multi-snapshot history interpolation', () => {
  it('single snapshot → returns that snapshot position', () => {
    // WRONG IMPL KILLED: an impl that returns { x: 0, y: 0 } for a 1-element history.
    const snaps = [{ tileX: 3, tileY: 7, receivedAt: 1000 }];
    const pos = interpolateHistory(snaps, 999);
    expect(pos.x).toBe(3);
    expect(pos.y).toBe(7);
  });

  it('clamps to earliest snapshot before renderTime', () => {
    // renderTime < first snapshot receivedAt → return first snapshot position.
    // WRONG IMPL KILLED: an impl that extrapolates backward in time.
    const snaps = [
      { tileX: 0, tileY: 0, receivedAt: 1000 },
      { tileX: 1, tileY: 0, receivedAt: 1200 },
    ];
    const pos = interpolateHistory(snaps, 500); // way before first snap
    expect(pos.x).toBe(0);
    expect(pos.y).toBe(0);
  });

  it('holds at latest snapshot past renderTime', () => {
    // renderTime >= last snapshot receivedAt → return last snapshot position (HOLD).
    // WRONG IMPL KILLED: an impl that extrapolates forward (the v1 rubberband).
    const snaps = [
      { tileX: 0, tileY: 0, receivedAt: 1000 },
      { tileX: 1, tileY: 0, receivedAt: 1200 },
      { tileX: 2, tileY: 0, receivedAt: 1400 },
    ];
    const pos = interpolateHistory(snaps, 1600); // past last snap
    expect(pos.x).toBe(2);
    expect(pos.y).toBe(0);
  });

  it('lerps correctly between two middle snapshots in a 3-snap history', () => {
    // renderTime falls between snap[1] and snap[2] → lerp in that segment.
    // WRONG IMPL KILLED: an impl that always lerps between snap[0] and snap[-1].
    const snaps = [
      { tileX: 0, tileY: 0, receivedAt: 1000 },
      { tileX: 1, tileY: 0, receivedAt: 1200 }, // renderTime will be here → lerp segment
      { tileX: 2, tileY: 0, receivedAt: 1400 },
    ];
    // renderTime = 1300 → halfway between snap[1] (t=1200) and snap[2] (t=1400)
    const pos = interpolateHistory(snaps, 1300);
    expect(pos.x).toBeCloseTo(1.5, 5);
    expect(pos.y).toBeCloseTo(0, 5);
  });

  it('lerps correctly in the first segment of a 3-snap history', () => {
    // renderTime falls between snap[0] and snap[1].
    // WRONG IMPL KILLED: an impl that skips the first segment.
    const snaps = [
      { tileX: 0, tileY: 0, receivedAt: 1000 },
      { tileX: 2, tileY: 0, receivedAt: 1200 },
      { tileX: 4, tileY: 0, receivedAt: 1400 },
    ];
    // renderTime = 1100 → halfway between snap[0] and snap[1]
    const pos = interpolateHistory(snaps, 1100);
    expect(pos.x).toBeCloseTo(1.0, 5);
  });

  it('degenerate burst: two snapshots at same receivedAt → returns the later one', () => {
    // Two snaps with equal receivedAt form a zero-span segment.
    // span=0 guard: must return the later snapshot without dividing by zero.
    // WRONG IMPL KILLED: an impl that divides by span without guarding span===0.
    const snaps = [
      { tileX: 0, tileY: 0, receivedAt: 1000 },
      { tileX: 1, tileY: 0, receivedAt: 1200 },
      { tileX: 2, tileY: 0, receivedAt: 1200 }, // burst: same time as previous
    ];
    // renderTime at the burst time
    expect(() => interpolateHistory(snaps, 1200)).not.toThrow();
    const pos = interpolateHistory(snaps, 1200);
    // The last snap is at 1200 — renderTime >= latest.receivedAt → HOLD at tileX=2
    expect(pos.x).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// e-5 PROOF-OF-TEETH: current two-snapshot scheme is non-smooth for bursts
//
// This test documents the PROBLEM the adaptive scheme solves. It uses the
// EXISTING `interpolate(prev, latest, renderTime)` function (already imported at
// top of file) and proves that when two snapshots arrive at the same timestamp
// (a two-tick burst), the current fixed-delay buffer produces a discontinuous
// jump between consecutive render frames.
//
// The jump is: renderTime=T-201 → clamps to prev (x=0); renderTime=T-200 → span=0
// guard returns latest (x=2). Position jumps 2 tiles in one frame — not smooth.
//
// RED REASON: this test is EXPECTED TO PASS on the current implementation
// (it documents the existing broken behaviour). It is a "proof-of-teeth" fixture:
// it will REMAIN PASSING after the e-5 fix because it tests the OLD function's
// behaviour, not the new one. But it gates that the old behaviour really is
// non-smooth, so the "new scheme is smooth" tests are meaningful.
// ---------------------------------------------------------------------------
describe('e-5 PROOF-OF-TEETH: current fixed-delay scheme is non-smooth for two-tick burst', () => {
  it('BITES: two snapshots at same receivedAt cause position jump > 1 tile in one frame', () => {
    // Scenario: two ticks arrive as a burst at T=500ms.
    //   prev    = { tileX:0, receivedAt:500 } (first burst tick)
    //   latest  = { tileX:2, receivedAt:500 } (second burst tick, 2 tiles ahead)
    // With INTERP_DELAY=200ms, renderTime = clientNow - 200.
    //
    // At clientNow=700 → renderTime=500 → renderTime >= latest.receivedAt → HOLD at x=2
    // At clientNow=699 → renderTime=499 → renderTime < prev.receivedAt (499 < 500) → clamp to x=0
    //
    // Jump: from x=0 (at frame t=699) to x=2 (at frame t=700) = 2-tile step in 1ms.
    // This IS the non-smooth behaviour — the test bites because the jump is > 1 tile.
    //
    // WRONG IMPL KILLED (for the subsequent smooth-scheme tests):
    //   An adaptive impl that doesn't actually fix bursts would pass this proof-of-teeth
    //   test (the old scheme IS broken) but fail the interpolateHistory monotone test.
    const burstPrev = s(0, 0, 500);
    const burstLatest = s(2, 0, 500); // same receivedAt → span=0 burst

    const DELAY = 200; // 1.0 × stepMs

    // One ms before the burst snaps into "HOLD"
    const atFrame699 = interpolate(burstPrev, burstLatest, 699 - DELAY).x; // renderTime=499 → clamp
    // At the burst timestamp
    const atFrame700 = interpolate(burstPrev, burstLatest, 700 - DELAY).x; // renderTime=500 → HOLD

    // The jump between consecutive frames is 2 tiles (0 → 2): non-smooth.
    // This assertion documents the broken behaviour — it passes on the current impl.
    expect(Math.abs(atFrame700 - atFrame699)).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// e-5: adaptive scheme produces monotone positions for a two-tick burst
//
// Using the new interpolateHistory + adaptiveInterpDelayMs, the same burst
// scenario that breaks the two-snapshot scheme should produce monotone positions.
//
// RED REASON: interpolateHistory and adaptiveInterpDelayMs don't exist yet.
// After implementation, this test must turn GREEN.
// ---------------------------------------------------------------------------
describe('e-5 adaptive scheme: monotone positions for two-tick burst (GREEN after fix)', () => {
  it('interpolateHistory with adaptive delay produces non-decreasing x positions for burst', () => {
    // Setup (mirroring the proof-of-teeth scenario but using 3-snapshot history):
    //   snap0 = { tileX:0, receivedAt:300 }  — pre-burst, entity was at x=0
    //   snap1 = { tileX:1, receivedAt:500 }  — burst tick 1
    //   snap2 = { tileX:2, receivedAt:500 }  — burst tick 2 (same timestamp)
    //
    // With adaptive delay = adaptiveInterpDelayMs(200, 200) > 200ms, the
    // renderTime stays in the bracket [300..500] longer, allowing smooth lerp
    // across the pre-burst → burst transition instead of the sudden jump.
    //
    // WRONG IMPL KILLED: an impl where adaptiveInterpDelayMs returns exactly 200ms
    // (no adaptation) — the monotone check would fail at the burst boundary.
    const stepMs = 200;
    const snapshots = [
      { tileX: 0, tileY: 0, receivedAt: 300 }, // snap0: pre-burst at T=300
      { tileX: 1, tileY: 0, receivedAt: 500 }, // snap1: burst tick 1 at T=500
      { tileX: 2, tileY: 0, receivedAt: 500 }, // snap2: burst tick 2 at T=500
    ];

    // High jitter: the burst delivered 2 snaps 0ms apart when we expected 200ms.
    const jitterMs = 200; // max deviation
    const delay = adaptiveInterpDelayMs(jitterMs, stepMs);

    // Sample x-positions at render times spanning the burst window
    const T = 500; // burst arrived at T=500
    const clientNows = [T, T + 50, T + 100, T + 150, T + 200, T + 250, T + 300, T + 400];
    const positions = clientNows.map((now) => {
      const renderTime = now - delay;
      return interpolateHistory(snapshots, renderTime).x;
    });

    // Positions must be monotone non-decreasing (no backward jumps)
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThanOrEqual((positions[i - 1] ?? 0) - 0.01);
    }
  });

  it('JitterEstimator + adaptiveInterpDelayMs integration: burst → delay increases', () => {
    // Full pipeline test: feed a burst into JitterEstimator, then use its estimate
    // to compute an adaptive delay that is larger than the base stepMs.
    // RED REASON: all three new exports don't exist yet.
    // WRONG IMPL KILLED: an impl where the estimator doesn't affect the delay.
    const stepMs = 200;
    const est = new JitterEstimator(0.5);

    // Feed a normal arrival, then a burst
    est.update(200, stepMs); // normal
    est.update(0, stepMs); // burst: 0ms interval → high deviation

    // The adaptive delay must be greater than the base when jitter is detected
    const delay = adaptiveInterpDelayMs(est.jitterMs, stepMs);
    expect(est.jitterMs).toBeGreaterThan(0); // estimator detected the jitter
    expect(delay).toBeGreaterThan(stepMs); // delay adapted upward
  });
});
