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

  it('delay >= INTERP_MIN_DELAY_STEPS×stepMs (lower clamp enforced)', () => {
    // The true lower bound is INTERP_MIN_DELAY_STEPS×stepMs (=0.5×stepMs=100ms, not stepMs).
    // At zero jitter, raw = 1.0×stepMs = 200, which already exceeds the 100ms lower clamp,
    // so these assertions happen to also be ≥ stepMs. A test with raw < stepMs would
    // expose the 0.5× clamp — see the positive jitter tests above for that path.
    // WRONG IMPL KILLED: an impl that subtracts jitter from stepMs (reduces delay on jitter).
    expect(adaptiveInterpDelayMs(0, 200)).toBeGreaterThanOrEqual(100); // lower clamp = 0.5×200
    expect(adaptiveInterpDelayMs(50, 200)).toBeGreaterThanOrEqual(100);
    expect(adaptiveInterpDelayMs(200, 200)).toBeGreaterThanOrEqual(100);
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

// =============================================================================
// 11r-f (ADR-0171) D2/D3/D5 — resume-from-idle re-anchored interpolation bracket
//
// SOURCE OF TRUTH: docs/adr/0171-resume-from-idle-interpolation.md (D2 re-anchor,
// D3 API, D5 constants) + spec M-postgate-eleventh-review-residuals §11r-f EARS E1:
//   "a 1-tile step after a >= 5 s idle renders as one smooth <= stepMs slide —
//    no pop, no post-resume max-delay clamp."
//
// NEW API: interpolateHistory(snapshots, renderTime, stepMs = 0)
//   * stepMs <= 0                                  -> re-anchoring DISABLED; today's
//                                                     math, byte-for-byte (D3).
//   * stepMs > 0 && rawSpan > 2 x stepMs           -> lower = next.receivedAt - stepMs
//       - renderTime <= lower                      -> HOLD at `prev` (the dead zone:
//                                                     the character genuinely stood there)
//       - renderTime  > lower                      -> lerp over the exactly-stepMs
//                                                     window [lower, next.receivedAt]
//   The outer HOLD (renderTime >= newest) / clamp (renderTime <= oldest) paths and
//   the raw span <= 0 guard are evaluated FIRST and are untouched; multi-bracket
//   rings re-anchor PER BRACKET.
//
// RED REASON (before impl): `interpolateHistory` takes two parameters today, so the
// third argument is silently ignored (vitest does not typecheck) and every
// re-anchor expectation below resolves to the legacy whole-gap crawl — e.g. x=5.5
// where the contract demands exactly x=5. The constant pin reds on
// `undefined !== 2`. Cases (i), (vii-a), (H-C) and (H-D) are deliberately GREEN both
// before and after the fix — they pin the legacy / steady-state / clamp behaviour the
// implementation must NOT disturb (each says so in its own comment).
// =============================================================================

import * as fc from 'fast-check';
// Namespace import ON PURPOSE (see case (ix)): REANCHOR_SPAN_STEPS does not exist
// yet, and a missing NAMED binding is an ESM link error that would take the whole
// FILE's collection down. Property access on the namespace reds as a clean
// `undefined !== 2` assertion failure instead.
import * as interpolationModule from './interpolation';

describe('11r-f re-anchor (ADR-0171)', () => {
  const STEP_MS = 200;

  /** The E1 bracket: the character stood on (5,5) for 5 s, then took ONE tile step
   *  to (6,5). rawSpan = 5000 ms = 25 x STEP_MS — far past the 2-step re-anchor
   *  threshold. Shared by cases (i), (iii), (iv), (v) and (vii-a). */
  const GAP_RING: readonly InterpSample[] = [s(5, 5, 1000), s(6, 5, 6000)];

  it('(i) LEGACY/BITES twin: with no stepMs the 5 s bracket crawls AND pops > 0.5 tile at the resume frame', () => {
    // ANTI-VACUITY TWIN. Deliberately GREEN both before and after the fix — it is
    // what makes every OTHER case in this describe meaningful:
    //   1. it pins the exact pre-11r-f crawl math (a = (rt - prev)/rawSpan) so the
    //      new greens below can only come from the NEW third argument;
    //   2. it demonstrates that the defect E1 names (a >0.5-tile single-frame pop
    //      at the resume frame) is REAL under that math, so the smoothness
    //      assertions are not asserting something that was already true.
    // WRONG IMPL KILLED: "the stepMs=0 path is not byte-legacy" (an implementer who
    // re-anchors unconditionally, or who deletes the disable path, reds here).

    // --- exact legacy crawl at four sample points inside the gap -----------------
    // a = (renderTime - 1000) / 5000
    expect(interpolateHistory(GAP_RING, 2000).x).toBeCloseTo(5.2, 10); // a = 0.20
    expect(interpolateHistory(GAP_RING, 3500).x).toBeCloseTo(5.5, 10); // a = 0.50
    expect(interpolateHistory(GAP_RING, 5800).x).toBeCloseTo(5.96, 10); // a = 0.96
    expect(interpolateHistory(GAP_RING, 5999).x).toBeCloseTo(5.9998, 10); // a = 0.9998
    // explicit stepMs=0 must reproduce the omitted-argument numbers bit-for-bit
    expect(interpolateHistory(GAP_RING, 2000, 0).x).toBe(interpolateHistory(GAP_RING, 2000).x);
    expect(interpolateHistory(GAP_RING, 3500, 0).x).toBe(interpolateHistory(GAP_RING, 3500).x);
    expect(interpolateHistory(GAP_RING, 5800, 0).x).toBe(interpolateHistory(GAP_RING, 5800).x);

    // --- the pop: the resume frame vs. the frame ~16 ms earlier ------------------
    // 16 ms earlier the resume snapshot has not arrived yet, so the ring is the
    // single pre-idle snapshot; at the resume frame renderTime = next - 200.
    const beforeArrival = interpolateHistory([s(5, 5, 1000)], 5984 - 200).x;
    const atResumeFrame = interpolateHistory(GAP_RING, 6000 - 200).x;
    expect(beforeArrival).toBe(5);
    expect(atResumeFrame).toBeCloseTo(5.96, 10);
    expect(Math.abs(atResumeFrame - beforeArrival)).toBeGreaterThan(0.5); // ~0.96 tile in one frame
  });

  it('(ii) BITES: the threshold is strictly > 2 x stepMs AND is tight at fractional spans', () => {
    // WRONG IMPL KILLED: `rawSpan >= REANCHOR_SPAN_STEPS * stepMs`. Under `>=` the
    // exactly-400 bracket would re-anchor to lower = 1400 - 200 = 1200, and
    // renderTime 1200 <= 1200 would HOLD at prev (x=0) instead of lerping to 0.5.
    // Exactly 2 x stepMs is ONE dropped tick — a legitimate two-step slide the
    // adaptive delay is designed to bridge (ADR-0171 D2).
    const spanExactly400: readonly InterpSample[] = [s(0, 0, 1000), s(1, 0, 1400)];
    expect(interpolateHistory(spanExactly400, 1200, STEP_MS).x).toBe(0.5); // legacy midpoint

    // One millisecond wider: 401 > 400 → re-anchor to lower = 1401 - 200 = 1201;
    // renderTime 1201 <= 1201 → dead zone → exactly prev.
    const span401: readonly InterpSample[] = [s(0, 0, 1000), s(1, 0, 1401)];
    expect(interpolateHistory(span401, 1201, STEP_MS)).toEqual({ x: 0, y: 0 });

    // H-A — SUB-MILLISECOND ALIASING. `performance.now()` is fractional in production,
    // so real brackets land a fraction of a millisecond past the threshold. An
    // integer-only boundary suite is passed by a slack comparison such as
    // `rawSpan > 2 * stepMs + 0.5` (verified live against a golden reference), which
    // silently un-re-anchors every bracket in the 400.0-400.5 ms band.
    // WRONG IMPL KILLED: any epsilon / rounding slack on the threshold comparison.
    const span400point3: readonly InterpSample[] = [s(0, 0, 1000), s(1, 0, 1400.3)];
    // rawSpan 400.3 > 400 → re-anchor; lower = 1400.3 - 200 = 1200.3 → 1200 is inside
    // the dead zone. A slack threshold lerps the raw span instead: a = 200/400.3 ≈ 0.4996.
    expect(interpolateHistory(span400point3, 1200, STEP_MS)).toEqual({ x: 0, y: 0 });
    // and one millisecond later, just INSIDE the re-anchored window:
    //   a = (1201 - 1200.3) / 200 = 0.7 / 200 = 0.0035
    // (a slack threshold gives a = 201/400.3 ≈ 0.5021 — two orders of magnitude out)
    expect(interpolateHistory(span400point3, 1201, STEP_MS).x).toBeCloseTo(0.0035, 6);
  });

  it('(iii) BITES: the dead zone holds EXACTLY at prev for every renderTime in (prev, next - stepMs]', () => {
    // WRONG IMPL KILLED (two of them):
    //   a) `lower = prev.receivedAt + stepMs` (front-anchored). That window is
    //      [1000, 1200]; at renderTime 3500 the character would already be sitting
    //      on the NEW tile for 4.8 s of the gap — it moves at gap START and freezes.
    //   b) "dead zone returns next" — a hold at the wrong end of the bracket, which
    //      teleports the sprite to the resume tile the instant the gap opens.
    for (const renderTime of [1001, 3500, 5800]) {
      expect(interpolateHistory(GAP_RING, renderTime, STEP_MS)).toEqual({ x: 5, y: 5 });
    }
  });

  it('(iv) the re-anchored slide window is exactly [next - stepMs, next] wide', () => {
    // lower = 6000 - 200 = 5800, so a = (renderTime - 5800) / 200.
    // WRONG IMPL KILLED: any other window arithmetic (span still rawSpan, lower off
    // by a step, a computed against prev.receivedAt) misses these fractions.
    expect(interpolateHistory(GAP_RING, 5850, STEP_MS).x).toBeCloseTo(5.25, 10); // a = 0.25
    expect(interpolateHistory(GAP_RING, 5900, STEP_MS).x).toBeCloseTo(5.5, 10); // a = 0.50
    expect(interpolateHistory(GAP_RING, 5950, STEP_MS).x).toBeCloseTo(5.75, 10); // a = 0.75
    expect(interpolateHistory(GAP_RING, 5999.99, STEP_MS).x).toBeCloseTo(5.99995, 9);
    // y never moves (both tiles are on row 5) — the lerp must not smear the axis.
    expect(interpolateHistory(GAP_RING, 5900, STEP_MS).y).toBe(5);
    // at/past the newest snapshot the untouched OUTER hold takes over (evaluated first)
    expect(interpolateHistory(GAP_RING, 6000, STEP_MS)).toEqual({ x: 6, y: 5 });
    expect(interpolateHistory(GAP_RING, 6400, STEP_MS)).toEqual({ x: 6, y: 5 });
  });

  it('(v) E1 HEADLINE: a 16 ms frame walk across the resume renders one <= stepMs slide, no pop', () => {
    // The criterion itself, at production cadence. FIXED delay for the walk (a clean
    // estimator: the D1 gate keeps jitterEwma at 0 across an idle gap, so D = stepMs).
    // Evolving-D is covered by the deterministic T-A case in renderResolver.test.ts.
    const D = adaptiveInterpDelayMs(0, STEP_MS);
    expect(D).toBe(200); // precondition: no jitter → base delay

    const FRAME_MS = 16;
    const times: number[] = [];
    const xs: number[] = [];
    for (let now = 5800; now <= 6400; now += FRAME_MS) {
      times.push(now);
      xs.push(interpolateHistory(GAP_RING, now - D, STEP_MS).x);
    }

    // WRONG IMPL KILLED: a gate-less / re-anchor-less implementation. Under legacy
    // math the walk STARTS at 5.92 (the ~0.9-tile pop has already happened before
    // the first frame) and never reaches 6 inside the window — both assertions red.
    expect(xs[0]).toBe(5); // rests on the old tile until the slide window opens
    expect(xs[xs.length - 1]).toBe(6); // and has fully arrived by the end of the walk

    let maxDelta = 0;
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]!); // never back-steps
      maxDelta = Math.max(maxDelta, Math.abs(xs[i]! - xs[i - 1]!));
    }
    expect(maxDelta).toBeLessThanOrEqual(FRAME_MS / STEP_MS + 1e-9); // <= 0.08 tile/frame

    // one tile of travel, completed within one step (+ one frame of sampling slack)
    const lastOnOldTile = xs.lastIndexOf(5);
    const firstOnNewTile = xs.indexOf(6);
    expect(lastOnOldTile).toBeGreaterThanOrEqual(0);
    expect(firstOnNewTile).toBeGreaterThan(lastOnOldTile);
    expect(times[firstOnNewTile]! - times[lastOnOldTile]!).toBeLessThanOrEqual(STEP_MS + FRAME_MS);
  });

  it('(vi) BITES: every bracket of a multi-bracket slow-NPC ring re-anchors, not just the newest', () => {
    // A slow-wander NPC: one tile every 5 s, depth-4 ring.
    // WRONG IMPL KILLED: "only the newest bracket is re-anchored" (e.g. an impl that
    // compares against snapshots[len-1].receivedAt instead of the located `next`) —
    // the two interior samples below would fall back to the legacy crawl (1.5 / 1.98).
    const NPC_RING: readonly InterpSample[] = [
      s(0, 0, 0),
      s(1, 0, 5000),
      s(2, 0, 10000),
      s(3, 0, 15000),
    ];
    // interior bracket B->C, deep inside the gap → dead zone at B
    expect(interpolateHistory(NPC_RING, 7500, STEP_MS)).toEqual({ x: 1, y: 0 });
    // interior bracket B->C, inside its re-anchored window [9800, 10000] → half way
    expect(interpolateHistory(NPC_RING, 9900, STEP_MS).x).toBeCloseTo(1.5, 10);
    // the next bracket C->D, window [14800, 15000] → half way again
    expect(interpolateHistory(NPC_RING, 14900, STEP_MS).x).toBeCloseTo(2.5, 10);
  });

  it('(H-C) BITES: on-cadence brackets are NEVER re-anchored, wherever they sit in the ring', () => {
    // Kills a bracket-INDEX cheat verified live against a golden reference:
    // `nextIdx >= 2 || rawSpan > REANCHOR_SPAN_STEPS * stepMs`. Every gap fixture in
    // this describe happens to bracket at a high ring index, so an index-based
    // "re-anchor" passes all of them while corrupting ordinary steady-state motion.
    // The re-anchor decision is a function of the bracket's SPAN ALONE — a bracket's
    // position in the ring must not enter it.
    // Deliberately GREEN today and after the fix: it pins the untouched steady state.
    const STEADY_RING: readonly InterpSample[] = [
      s(0, 0, 0),
      s(1, 0, 200),
      s(2, 0, 400),
      s(3, 0, 700), // a 300 ms hiccup: still <= 2 x stepMs, so still a plain lerp
    ];
    // bracket idx2 -> idx3 (nextIdx = 3), rawSpan 300 <= 400 → legacy math:
    //   a = (450 - 400) / 300 = 1/6 → x = 2 + 1/6 = 2.1666666666666665
    // The index cheat re-anchors to lower = 700 - 200 = 500, sees 450 <= 500, and
    // freezes at prev → x = 2 exactly.
    expect(interpolateHistory(STEADY_RING, 450, STEP_MS).x).toBe(2.1666666666666665);
  });

  it('(H-D) BITES: the oldest-clamp survives stepMs > 0 (no v1 backward extrapolation)', () => {
    // Kills `if (stepMs <= 0 && renderTime <= oldest.receivedAt) return oldest` — a
    // cheat verified live to pass an integer-only suite while REINTRODUCING the v1
    // backward rubberband ADR-0013 exists to prevent. With the clamp gated off,
    // renderTime 800 falls through into the 1000→1200 bracket at
    // a = (800 - 1000)/200 = -1 and renders x = -1: a whole tile BEHIND the oldest
    // position ever observed. The outer clamp/HOLD paths are untouched by ADR-0171
    // (D2) and must be evaluated before any re-anchor logic.
    // Deliberately GREEN today and after the fix.
    const RING: readonly InterpSample[] = [s(0, 0, 1000), s(1, 0, 1200)];
    expect(interpolateHistory(RING, 800, STEP_MS)).toEqual({ x: 0, y: 0 });
  });

  it('(vii-a) degenerate: stepMs <= 0 disables re-anchoring entirely (byte-legacy)', () => {
    // Deliberately GREEN both before and after the fix — the "no stepMs ⇒ old math"
    // regression property ADR-0171 D3 keeps the default parameter for.
    // WRONG IMPL KILLED: `stepMs !== undefined` / truthiness checks that treat a
    // negative or zero step as "enabled" (a caller passing a not-yet-known step_ms()
    // would silently get re-anchoring with a nonsense window).
    const legacyMid = interpolateHistory(GAP_RING, 3500).x;
    const legacyLate = interpolateHistory(GAP_RING, 5800).x;
    expect(legacyMid).toBeCloseTo(5.5, 10);
    expect(legacyLate).toBeCloseTo(5.96, 10);
    for (const disabled of [0, -1]) {
      expect(interpolateHistory(GAP_RING, 3500, disabled).x).toBe(legacyMid);
      expect(interpolateHistory(GAP_RING, 5800, disabled).x).toBe(legacyLate);
    }
  });

  it('(vii-b) degenerate: duplicate-timestamp bracket, empty and length-1 rings are unaffected by the new argument', () => {
    // WHAT THIS VERIFIES: bracket-SCAN correctness when a duplicate `receivedAt` sits
    // strictly interior to the ring (indices 1 and 2), with re-anchoring on. The scan
    // must advance `prev` past BOTH duplicates, so prev = (2,0)@3000 (not (1,0)@3000)
    // and next = (3,0)@9000; rawSpan = 6000 > 400 → dead zone → exactly (2,0).
    //
    // WHAT IT DOES *NOT* VERIFY (explicitly, so nobody re-derives the claim): the
    // `span <= 0` guard's ORDERING relative to the re-anchor. That guard is
    // unreachable through the public API — the scan guarantees
    // prev.receivedAt <= renderTime < next.receivedAt ⇒ rawSpan > 0, and the
    // no-break case makes prev === newest, which the outer HOLD already returned.
    // interpolation.ts:200-206 documents it as a defensive check against future
    // ring-invariant violations; ADR-0171 D2 keeps it on the RAW span for that
    // reason, and no black-box fixture can discriminate the two orderings.
    const DUP_RING: readonly InterpSample[] = [
      s(0, 0, 1000),
      s(1, 0, 3000),
      s(2, 0, 3000), // duplicate receivedAt, strictly interior
      s(3, 0, 9000),
    ];
    expect(interpolateHistory(DUP_RING, 4000, STEP_MS)).toEqual({ x: 2, y: 0 });

    // empty / single-snapshot rings must be untouched by the third argument
    expect(interpolateHistory([], 4000, STEP_MS)).toEqual({ x: 0, y: 0 });
    expect(interpolateHistory([s(3, 7, 1000)], 4000, STEP_MS)).toEqual({ x: 3, y: 7 });
  });

  it('(viii) PROPERTY: for any idle gap / step / fixed delay / frame interval the resume slide is smooth', () => {
    // Block-body arrow ONLY (project standard): fast-check misreads an
    // expression-body matcher return value as a `false` predicate.
    //
    // D is FIXED for each generated walk (a per-frame-evolving delay is the
    // deterministic T-A case in renderResolver.test.ts, ADR-0171 Consequences).
    //
    // The generated bracket span is floored at stepMs: a bracket NARROWER than one
    // step cannot satisfy `delta <= dt/stepMs` under ANY implementation (a 1 ms
    // bracket must move a whole tile inside one frame), so a sub-step span would
    // make the property arithmetically false rather than test anything.
    //
    // WRONG IMPL KILLED: a broad class — seam discontinuities, off-by-one window
    // edges, span-dependent slide duration. Today it reds on the `xs[0] === 0`
    // and transition-duration clauses (legacy math starts the walk mid-crawl at
    // (G - D)/G, e.g. 0.958 for a 20 s gap).
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 20000, noNaN: true, noDefaultInfinity: true }),
        fc.constantFrom(50, 100, 200, 333),
        fc.double({ min: 1, max: 2.5, noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: 8, max: 33 }),
        (gapMs, stepMs, delayMult, dt) => {
          const t0 = 1000;
          const span = Math.max(gapMs, stepMs);
          const ring: readonly InterpSample[] = [s(0, 0, t0), s(1, 0, t0 + span)];
          const D = delayMult * stepMs; // fixed for the whole walk

          const times: number[] = [];
          const xs: number[] = [];
          for (let now = t0 + gapMs; now <= t0 + gapMs + D + 2 * stepMs; now += dt) {
            times.push(now);
            xs.push(interpolateHistory(ring, now - D, stepMs).x);
          }

          // H-D — UNCONDITIONAL bounds, outside the re-anchor-eligible branch below:
          // a walk whose delay exceeds the gap starts BEFORE the oldest snapshot, and
          // a cheat that gates the oldest-clamp on `stepMs <= 0` renders a NEGATIVE
          // tile there (backward extrapolation, the v1 rubberband). The upper bound is
          // the matching anti-extrapolation clause for the HOLD path.
          for (const x of xs) {
            expect(x).toBeGreaterThanOrEqual(0); // never behind the older tile
            expect(x).toBeLessThanOrEqual(1); // never past the newer tile
          }

          for (let i = 1; i < xs.length; i++) {
            expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]!); // monotone non-decreasing
            expect(Math.abs(xs[i]! - xs[i - 1]!)).toBeLessThanOrEqual(dt / stepMs + 1e-9);
          }
          expect(xs[xs.length - 1]!).toBe(1); // always ends ON the newest snapshot

          if (span > 2 * stepMs) {
            // Re-anchor-eligible: D >= stepMs always, so the window is entered from
            // the dead-zone side at a = 0 and the whole slide fits in one step.
            expect(xs[0]!).toBe(0);
            const lastOnPrev = xs.lastIndexOf(0);
            const firstOnNext = xs.indexOf(1);
            expect(lastOnPrev).toBeGreaterThanOrEqual(0);
            expect(firstOnNext).toBeGreaterThan(lastOnPrev);
            // The slide itself is exactly stepMs long; sampling on a dt grid can only
            // stretch the OBSERVED transition by one frame at each end (the last
            // dead-zone sample sits up to dt before `lower`, the first HOLD sample up
            // to dt after `next`) — hence stepMs + 2*dt, not stepMs + dt. Under
            // legacy math the observed transition is ~gapMs (up to 20 s) instead.
            expect(times[firstOnNext]! - times[lastOnPrev]!).toBeLessThanOrEqual(
              stepMs + 2 * dt + 1e-9,
            );
          }
        },
      ),
    );
  });

  it('(ix) PIN: REANCHOR_SPAN_STEPS is exported from interpolation.ts and equals 2 (ADR-0171 D5)', () => {
    // Literal pin so an implementer cannot silently relax the threshold. Accessed
    // off the module NAMESPACE rather than as a named import because the export does
    // not exist yet: a missing named binding is an ESM link error that would abort
    // collection of this entire FILE; property access reds as `undefined !== 2`.
    // The twin pin (JITTER_IDLE_GAP_STEPS === 3) lives in net/store.test.ts; ADR-0171
    // D5 keeps the two constants deliberately independent — do not unify them.
    expect((interpolationModule as unknown as Record<string, unknown>).REANCHOR_SPAN_STEPS).toBe(2);
  });
});

import type { StoreCharacter } from '../net/store';

// =============================================================================
// m23-s7 — interpolateReducedMotion (A11Y-27)
//
// SOURCE OF TRUTH: M23-accessibility.spec.md §2.5 — under the OS reduced-motion
// preference a remote character is drawn AT its authoritative tile: no interpolation,
// no delay buffer, no rounding, no clamping, no dependence on `now`. The function is
// the pure half of that rule; renderResolver.test.ts §11 pins the call site.
//
// DELIBERATE DEVIATION from the tester brief (which asked for a named import):
// `interpolateReducedMotion` does not exist yet, and in this repo a missing NAMED
// binding is an ESM link error that takes the WHOLE FILE's collection down — the very
// reason case (ix) above reaches for the module NAMESPACE instead (see the comment on
// the `import * as interpolationModule` line). Going through that same namespace keeps
// the ~40 pre-existing tests in this file GREEN during the red phase and reds each new
// test below individually, on its own missing function, which is what a TDD red is
// supposed to look like.
// =============================================================================

describe('m23-s7 interpolateReducedMotion (A11Y-27)', () => {
  // Resolved off the namespace when this describe body runs: `undefined` before the
  // implementation lands (each `it` below then reds with a clean "is not a function"),
  // the real function after it.
  const interpolateReducedMotion = interpolationModule.interpolateReducedMotion;

  it('S7T-IRM-IDENT: returns the row tile IDENTICALLY — full row shape, negative tiles, no rounding, no clamping', () => {
    // A FULL StoreCharacter row, not a two-field stub: the production caller passes
    // `c.row`, so the parameter type must be satisfiable BY that shape. A signature
    // typed `InterpSample` (which requires `receivedAt`) would not accept this object
    // at the call site — the structural half of the proof, and the reason the plan
    // forbids reusing InterpSample for the new parameter.
    const row: StoreCharacter = {
      entityId: 42n,
      zoneId: 3,
      tileX: -7,
      tileY: -12,
      facing: 'West',
      action: 'Idle',
      moveStartedAtMs: 1234n,
      moveQueue: [],
    };

    // NEGATIVE tiles are the value half. WRONG IMPLS KILLED:
    //   Math.max(0, tileX) or any clamp-to-map-bounds -> 0, not -7
    //   Math.abs / a sign-dropping copy               -> 7, not -7
    //   x/y transposed                                -> { x: -12, y: -7 }
    const pos = interpolateReducedMotion(row);
    expect(pos).toEqual({ x: -7, y: -12 });
    expect(pos.x).toBe(-7);
    expect(pos.y).toBe(-12);
    // exactly the two RenderPos fields — no `tileX`/`receivedAt` leaking through a
    // spread-based implementation into a type the renderer treats as a position.
    expect(Object.keys(pos).sort()).toEqual(['x', 'y']);

    // A FRACTIONAL probe. WHY it violates a production invariant on purpose:
    // authoritative tiles are always integers, so an integer-only fixture cannot see
    // a Math.round / Math.floor / Math.trunc hiding inside the "identity" function.
    // This input is impossible in production and exists solely to kill that mutation.
    const fractional = interpolateReducedMotion({ tileX: 2.5, tileY: -3.25 });
    expect(fractional).toEqual({ x: 2.5, y: -3.25 });

    // Zero stays +0: a -0 would render identically but signals a sign-mangling
    // arithmetic "identity" (e.g. `0 - tileX * -1`). Object.is, because toEqual's
    // treatment of -0 is not something this suite should depend on.
    const zero = interpolateReducedMotion({ tileX: 0, tileY: 0 });
    expect(Object.is(zero.x, 0)).toBe(true);
    expect(Object.is(zero.y, 0)).toBe(true);
  });

  it('S7T-IRM-PURE: pure — a frozen input is never mutated and every call returns a FRESH object', () => {
    const input = Object.freeze({ tileX: -1, tileY: 4 });

    // FREEZE SAFETY: an implementation that writes back into its argument (e.g.
    // "normalising" `row.tileX = Math.floor(row.tileX)` before returning) THROWS on a
    // frozen object — ES modules are always strict — so this call is the assertion.
    const first = interpolateReducedMotion(input);
    const second = interpolateReducedMotion(input);

    expect(first).toEqual({ x: -1, y: 4 });
    expect(second).toEqual(first); // same input, same answer: no hidden per-call state
    expect(input).toEqual({ tileX: -1, tileY: 4 }); // the argument is untouched
    expect(Object.isFrozen(input)).toBe(true);

    // A FRESH object per call. WRONG IMPL KILLED: a module-level memo
    // (`let last: RenderPos | undefined`) — hidden state in a module whose header
    // declares it PURE, invisible to every value assertion above and to the source
    // scan, and a shared object that every caller would silently alias.
    expect(first).not.toBe(second);
  });
});
