// observability/frameWindow.test.ts — m20c (ADR-0180 body amendment), OBS-25 + T-25c/T-25d/T-P3.
//
// SOURCE OF TRUTH: EARS OBS-25 (fps SLO, p50 ≥ 55, sourced from `mr_client_fps_bucket`) + AM14
// (anomalous windows are DISCARDED) + the plan's per-frame cost budget (§4: "3 number updates,
// 1 compare; no alloc, no export, no attr hashing").
//
// WHAT THIS MODULE IS: a 1-second frame accumulator with an INJECTED clock. main.ts already
// computes `const now = performance.now()` once per rAF frame (main.ts:2415) and hands it in;
// this module never reads a clock, which is what makes it unit-testable in the NODE vitest
// environment and what makes the tests below deterministic without fake timers.
//
// THE API THIS FILE FIXES (the implementer must match it exactly):
//   createFrameWindow(nowMs): FrameWindowState        — a MUTABLE accumulator, seeded at nowMs
//   frameTick(state, nowMs): FrameTickResult          — { state, sample: FrameSample | undefined }
//   FrameSample = { fps, maxFrameMs }
//   FRAME_WINDOW_MS = 1000, FRAME_WINDOW_DISCARD_MS = 2000
//
// SEMANTICS, stated once so every assertion below reads as a consequence:
//   Each tick: dt = nowMs − state.lastTickMs; frames += 1; maxFrameMs = max(maxFrameMs, dt);
//   lastTickMs = nowMs. Then, with elapsed = nowMs − state.windowStartMs:
//     elapsed <  1000 …………………… no sample; the window keeps accumulating.
//     1000 ≤ elapsed ≤ 2000 ……… EMIT { fps: frames × 1000 / elapsed, maxFrameMs }, then reset the
//                                 window to start at nowMs with zero frames.
//     elapsed >  2000 …………………… DISCARD (AM14): reset with NO sample. A backgrounded tab suspends
//                                 rAF; the "1 frame in 45 seconds" window it produces on return
//                                 is a tab-suspend artifact, and folding it into the SLO would
//                                 make the fps p50 a function of how often players alt-tab.
//
// RED REASON: `client/src/observability/frameWindow.ts` does not exist yet.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  createFrameWindow,
  FRAME_WINDOW_DISCARD_MS,
  FRAME_WINDOW_MS,
  type FrameSample,
  frameTick,
} from './frameWindow';

describe('frameWindow (T-25c): one sample per elapsed second, fps = frames × 1000 / elapsed', () => {
  it('T-25c-window: the boundary is 1000ms — 999 emits nothing, 1000 emits', () => {
    // WRONG IMPL KILLED (1): a strict `elapsed > 1000` comparison paired with a caller that ticks
    //   exactly on the millisecond — the window would run 1 frame long every time and the fps
    //   would read low by one frame's worth, permanently, right at the 55fps SLO threshold.
    // WRONG IMPL KILLED (2): a FRAME-COUNT window ("emit every 60 frames"), which reports 60fps
    //   on a machine rendering at 30fps because the denominator is assumed rather than measured.
    expect(FRAME_WINDOW_MS).toBe(1000);

    const state = createFrameWindow(0);
    expect(frameTick(state, 500).sample).toBeUndefined();
    expect(frameTick(state, 999).sample).toBeUndefined();

    const closed = frameTick(state, 1000);
    expect(closed.sample).toBeDefined();
    // 3 ticks in a 1000ms window.
    expect(closed.sample?.fps).toBeCloseTo(3, 10);
  });

  it('T-25c-exact: ten 100ms frames close one window with fps 10 and maxFrameMs 100', () => {
    // WRONG IMPL KILLED (double-count inflation): a window that is reset WITHOUT zeroing the
    // frame counter, or that emits before decrementing — the second second reports 20fps on a
    // machine rendering 10, and the SLO panel says everything is fine.
    const state = createFrameWindow(0);
    const samples: FrameSample[] = [];
    for (let t = 100; t <= 1000; t += 100) {
      const r = frameTick(state, t);
      if (r.sample !== undefined) samples.push(r.sample);
    }
    expect(samples).toHaveLength(1);
    expect(samples[0]?.fps).toBeCloseTo(10, 10);
    expect(samples[0]?.maxFrameMs).toBeCloseTo(100, 10);
  });

  it('T-25c-repeat: three consecutive seconds emit exactly three samples, each self-contained', () => {
    // WRONG IMPL KILLED: a maxFrameMs that is never reset — the worst hitch of the SESSION would
    // be re-reported every second, so `mr_client_frame_time_max_ms` would look like a permanent
    // stutter after one GC pause. Each window must report only its OWN worst frame.
    const state = createFrameWindow(0);
    const samples: FrameSample[] = [];
    // Window 1: ten clean 100ms frames. Window 2: one 400ms hitch planted at 1700 (the tick
    // stream stays strictly increasing — a backwards timestamp is a different case, covered by
    // T-25d-backwards). Window 3: clean again.
    const ticks = [
      100,
      200,
      300,
      400,
      500,
      600,
      700,
      800,
      900,
      1000, //
      1100,
      1200,
      1300,
      1700,
      1800,
      1900,
      2000, //
      2100,
      2200,
      2300,
      2400,
      2500,
      2600,
      2700,
      2800,
      2900,
      3000,
    ];
    for (const t of ticks) {
      const r = frameTick(state, t);
      if (r.sample !== undefined) samples.push(r.sample);
    }
    expect(samples).toHaveLength(3);
    expect(samples[0]?.maxFrameMs).toBeCloseTo(100, 10);
    expect(samples[0]?.fps).toBeCloseTo(10, 10);
    expect(samples[1]?.maxFrameMs, 'the hitch belongs to window 2').toBeCloseTo(400, 10);
    expect(samples[1]?.fps, '7 frames in the 1000ms window 2').toBeCloseTo(7, 10);
    expect(samples[2]?.maxFrameMs, 'window 3 must not inherit window 2 hitch').toBeCloseTo(100, 10);
  });

  it('T-25c-measured: a window that closes LATE divides by the measured elapsed, not by 1000', () => {
    // RED-TEAM X6. Every other fixture in this file lands on an exact 1000ms boundary, where
    // `frames × 1000 / elapsed` and `frames` are numerically identical — so the whole
    // nominal-vs-measured distinction was carried by the property test alone. This fixture
    // separates them by 5 fps, right on the OBS-25 threshold.
    //
    // 55 frames in a window that closes at 1100ms is 50.0 fps. An implementation that divides by
    // the NOMINAL 1000 reports 55.0 — which is exactly the SLO line (p50 ≥ 55). The bug would
    // therefore turn a failing machine into a passing one at precisely the value the SLO is
    // defined at, and every boundary-aligned test in this file would still be green.
    // 54 clean 18ms frames (elapsed 972ms — the window is still open), then a 128ms hitch that
    // lands the 55th frame at 1100ms and closes the window LATE. That is the ordinary shape: a
    // GC pause or a zone load at the end of a second.
    const state = createFrameWindow(0);
    const samples: FrameSample[] = [];
    for (let i = 1; i <= 54; i += 1) {
      const r = frameTick(state, i * 18);
      if (r.sample !== undefined) samples.push(r.sample);
    }
    expect(samples, 'no window may close before 1000ms elapsed (54 × 18 = 972)').toHaveLength(0);

    const closing = frameTick(state, 1100);
    expect(closing.sample, 'the window must close on the 1100ms frame').toBeDefined();
    expect(
      closing.sample?.fps,
      '55 frames over a MEASURED 1100ms window is 50.0 fps. A value of 55 means the divisor is ' +
        'the nominal 1000ms — a systematic upward bias that reports "exactly at the SLO" for a ' +
        'machine running 10% below it.',
    ).toBeCloseTo(50, 10);
    expect(closing.sample?.maxFrameMs, 'the 128ms hitch is this window worst frame').toBeCloseTo(
      128,
      10,
    );
  });

  it('T-25c-property: every emitted sample equals frames×1000/elapsed over ITS OWN window', () => {
    // The rule, not a sample of it. The test tracks the frames and the window start itself, so
    // it never re-implements the module — it only re-states the arithmetic OBS-25 depends on.
    // WRONG IMPL KILLED: fps computed against the NOMINAL 1000ms instead of the MEASURED elapsed
    // time. On a 55fps machine the window closes at ~1009ms with 56 frames; dividing by 1000
    // reports 56.0 instead of 55.5 — a systematic upward bias sitting exactly on the SLO line.
    // dt ≤ 50ms, so a window can never reach the 2000ms discard threshold: the emission oracle
    // below ("emit exactly when the accumulated elapsed has reached 1000ms") is total here.
    const dts = fc.array(fc.integer({ min: 5, max: 50 }), { minLength: 200, maxLength: 400 });
    fc.assert(
      fc.property(dts, (steps) => {
        const state = createFrameWindow(0);
        let now = 0;
        let framesSinceSample = 0;
        let windowStart = 0;
        let maxDtSinceSample = 0;

        for (const dt of steps) {
          now += dt;
          framesSinceSample += 1;
          maxDtSinceSample = Math.max(maxDtSinceSample, dt);

          const elapsed = now - windowStart;
          const mustEmit = elapsed >= FRAME_WINDOW_MS;
          const r = frameTick(state, now);

          // EXACTLY once per elapsed second, stated as an iff: a missed emission (window
          // silently swallowed) and a doubled emission (reset that forgets to move the window
          // start) are both caught here, not just "the count looks about right".
          expect(
            r.sample !== undefined,
            `elapsed=${elapsed}ms: emission must happen iff elapsed >= ${FRAME_WINDOW_MS}`,
          ).toBe(mustEmit);
          if (r.sample === undefined) continue;

          expect(elapsed).toBeLessThan(FRAME_WINDOW_DISCARD_MS);
          expect(r.sample.fps).toBeCloseTo((framesSinceSample * 1000) / elapsed, 6);
          expect(r.sample.maxFrameMs).toBeCloseTo(maxDtSinceSample, 6);

          framesSinceSample = 0;
          maxDtSinceSample = 0;
          windowStart = now;
        }
      }),
      { seed: 20250809, numRuns: 100 },
    );
  });

  it('T-25c-sane: fps is always finite and positive — never NaN, never Infinity', () => {
    // WRONG IMPL KILLED: a zero-length window (two ticks at the same timestamp after a reset)
    // dividing by zero and shipping `Infinity` into a histogram. OTel would happily record it,
    // and one Infinity poisons the +Inf bucket the SLO quantile is interpolated from.
    const state = createFrameWindow(0);
    const samples: FrameSample[] = [];
    for (const t of [0, 0, 1000, 1000, 1000, 2000, 2000]) {
      const r = frameTick(state, t);
      if (r.sample !== undefined) samples.push(r.sample);
    }
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) {
      expect(Number.isFinite(s.fps), `fps=${s.fps}`).toBe(true);
      expect(s.fps).toBeGreaterThan(0);
      expect(Number.isFinite(s.maxFrameMs)).toBe(true);
      expect(s.maxFrameMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('frameWindow (T-25d/AM14): an anomalous window is DISCARDED, not reported', () => {
  it('T-25d: a >2000ms window (backgrounded tab) yields NO sample and resets the accumulator', () => {
    // AM14. WRONG IMPL KILLED: emitting the suspended window. rAF stops in a hidden tab, so the
    // window that spans the alt-tab reports something like 3 frames in 45 seconds — 0.07 fps.
    // Those land in the lowest bucket and drag `mr:client_fps_p50` down for every player who
    // switches tabs, turning the OBS-25 SLO into an alt-tab detector. There is no honest number
    // to report for a window in which the browser did not schedule frames: discard it.
    expect(FRAME_WINDOW_DISCARD_MS).toBe(2000);

    const state = createFrameWindow(0);
    expect(frameTick(state, 100).sample).toBeUndefined();
    expect(frameTick(state, 200).sample).toBeUndefined();

    const jumped = frameTick(state, 45_000);
    expect(jumped.sample, 'a 45s window must NOT produce an fps sample').toBeUndefined();

    // …and the accumulator is RESET, not merely skipped: the next full second reports normally
    // and carries neither the suspended frames nor the 44.8s "frame time".
    const samples: FrameSample[] = [];
    for (let t = 45_100; t <= 46_000; t += 100) {
      const r = frameTick(state, t);
      if (r.sample !== undefined) samples.push(r.sample);
    }
    expect(samples).toHaveLength(1);
    expect(samples[0]?.fps).toBeCloseTo(10, 10);
    expect(
      samples[0]?.maxFrameMs,
      'the 44.8s suspend gap must not survive into the next window maxFrameMs',
    ).toBeCloseTo(100, 10);
  });

  it('T-25d-boundary: exactly 2000ms still EMITS; one millisecond past it discards', () => {
    // The boundary is stated as `> 2000`, so 2000 itself is a legitimate (if slow) window —
    // half-rate rendering with a couple of dropped frames, which the SLO SHOULD see.
    // WRONG IMPL KILLED: `>=` at the discard test, which silently drops genuinely-bad frames —
    // exactly the sessions OBS-25 exists to reveal.
    const onEdge = createFrameWindow(0);
    frameTick(onEdge, 1000);
    // The window restarted at 1000; close the next one exactly 2000ms later.
    expect(frameTick(onEdge, 3000).sample, 'elapsed === 2000 must emit').toBeDefined();

    const past = createFrameWindow(0);
    frameTick(past, 1000);
    expect(frameTick(past, 3001).sample, 'elapsed === 2001 must discard').toBeUndefined();
  });

  it('T-25d-backwards: a non-monotonic clock never emits a negative-fps or negative-frame sample', () => {
    // performance.now() is monotonic per spec, but the accumulator is fed from a caller and the
    // module is the last line of defence. WRONG IMPL KILLED: an unguarded subtraction producing
    // a negative elapsed → negative fps → a datapoint below every bucket boundary.
    const state = createFrameWindow(10_000);
    const results = [
      frameTick(state, 9_000),
      frameTick(state, 9_100),
      frameTick(state, 11_000),
      frameTick(state, 12_500),
    ];
    for (const r of results) {
      if (r.sample === undefined) continue;
      expect(r.sample.fps).toBeGreaterThan(0);
      expect(Number.isFinite(r.sample.fps)).toBe(true);
      expect(r.sample.maxFrameMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('frameWindow (T-P3): the per-frame path allocates no new state', () => {
  it('T-P3: a non-boundary tick returns the SAME state object it was given', () => {
    // The rAF body runs this 60 times a second for the whole session. WRONG IMPL KILLED: the
    // copy-on-write shape `return { state: { ...state, frames: state.frames + 1 }, sample }`.
    // It is the natural "pure functional" reflex, it passes every behavioural test in this file,
    // and it mints 3600 short-lived objects per minute in the hottest loop the client has —
    // GC pressure that shows up as exactly the frame hitches `mr_client_frame_time_max_ms` is
    // supposed to be MEASURING. Identity is the only observable that catches it.
    const state = createFrameWindow(0);
    for (const t of [16, 33, 50, 66, 83, 100, 500, 999]) {
      const r = frameTick(state, t);
      expect(r.sample).toBeUndefined();
      expect(r.state, `tick at ${t}ms must not replace the accumulator`).toBe(state);
    }
  });

  it('T-P3-seed: createFrameWindow seeds from the injected clock (no implicit zero start)', () => {
    // WRONG IMPL KILLED: `windowStartMs = 0` at construction. main.ts creates the accumulator
    // after wasm init and page load — several thousand ms into `performance.now()` — so a
    // zero-seeded window would be >2000ms old on its very first tick and the AM14 discard would
    // swallow the first window of every session (with the wasm-warm frames in it).
    const state = createFrameWindow(5_000);
    expect(frameTick(state, 5_100).sample).toBeUndefined();
    expect(frameTick(state, 5_999).sample).toBeUndefined();
    expect(frameTick(state, 6_000).sample).toBeDefined();
  });
});
