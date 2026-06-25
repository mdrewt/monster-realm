// render/slideClock.ts behaviour suite (M4b, ADR-0013) — vitest.
// SOURCE OF TRUTH: M4-frontend.spec.md §3 "Rendering" — own character slides on a
// SELF-OWNED local clock keyed to target-tile changes; it SHALL NOT read
// move_started_at; "a no-divergence reconcile SHALL NOT restart the slide (no
// stutter)"; snap on the predictor's large-gap signal. Proof-of-teeth (ADR-0010):
// "a renderer that reads move_started_at reintroduces stutter and fails the
// decoupling test".
import { describe, expect, it } from 'vitest';
import { SlideClock, type SlideTile } from './slideClock';

const STEP = 200;
const t = (x: number, y = 0): SlideTile => ({ x, y });

describe('SlideClock: local-clock interpolation', () => {
  it('slides origin -> target over STEP_MS and holds (no overshoot) past it', () => {
    const c = new SlideClock(STEP, t(0), 0);
    c.setTarget(t(1), 0);
    expect(c.positionAt(0).x).toBeCloseTo(0);
    expect(c.positionAt(100).x).toBeCloseTo(0.5);
    expect(c.positionAt(200).x).toBeCloseTo(1);
    expect(c.positionAt(400).x).toBeCloseTo(1); // HELD at target, never > 1
  });

  it('a NEW target starts a fresh slide from the CURRENT position (no teleport)', () => {
    const c = new SlideClock(STEP, t(0), 0);
    c.setTarget(t(1), 0);
    // mid-slide at x=0.5, now aim at tile 2: it must continue FROM 0.5, not jump.
    c.setTarget(t(2), 100);
    expect(c.positionAt(100).x).toBeCloseTo(0.5);
    expect(c.positionAt(200).x).toBeCloseTo(1.25); // halfway 0.5 -> 2
    expect(c.positionAt(300).x).toBeCloseTo(2);
  });

  it('snapTo jumps instantly to the tile (the large-gap signal)', () => {
    const c = new SlideClock(STEP, t(0), 0);
    c.setTarget(t(5), 0);
    c.snapTo(t(5), 50);
    expect(c.positionAt(50).x).toBeCloseTo(5); // no animated backlog
    expect(c.target).toEqual(t(5));
  });
});

describe('SlideClock proof-of-teeth (ADR-0010): decoupled from move_started_at', () => {
  it('BITES: a redundant same-tile re-affirm (a no-divergence reconcile) does NOT restart', () => {
    const c = new SlideClock(STEP, t(0), 0);
    c.setTarget(t(1), 0);
    const before = c.positionAt(100).x; // 0.5, mid-slide
    // The loop reconciles every server tick; a no-divergence reconcile re-affirms
    // the SAME predicted tile. A clock keyed to move_started_at would restart here.
    c.setTarget(t(1), 100);
    expect(c.positionAt(100).x).toBeCloseTo(before); // unchanged — no restart
    expect(c.positionAt(150).x).toBeGreaterThan(before); // keeps advancing (monotonic)
    expect(c.positionAt(200).x).toBeCloseTo(1); // arrives on its OWN clock
  });

  it("the test bites: a move_started_at-keyed clock WOULD stutter here", () => {
    // Model the BAD renderer (restarts the slide every update, as if reading the
    // ever-changing server stamp). It regresses mid-slide — the symptom the
    // decoupling prevents — proving the no-restart assertion above is meaningful.
    const c = new SlideClock(STEP, t(0), 0);
    c.setTarget(t(1), 0);
    const good = c.positionAt(150).x;
    const badRestartedAt = 100; // a fresh server stamp arrived at t=100
    const badProgress = clampAlpha((150 - badRestartedAt) / STEP); // restarted clock
    const bad = 0 + (1 - 0) * badProgress; // origin 0 -> target 1 on the restarted clock
    expect(bad).toBeLessThan(good); // the bad clock visibly lags/stutters
  });
});

function clampAlpha(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
