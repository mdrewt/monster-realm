// ui/zoneSyncGuard.test.ts — RED tests for M13.5e e-2: zone-sync failure counting.
//
// SOURCE OF TRUTH: M13.5 §5 e-2 (EARS criterion)
//
// EARS criterion:
//   WHEN the state-based zone check fails AND switchZone did not take effect,
//   THE reconcile listener SHALL return before predicting. After N (≥ 3) consecutive
//   failures, it SHALL surface "content out of date — reload" to the user.
//
// main.ts is a module with side effects (wasm imports, DOM bootstrap) and cannot
// be unit-tested without a full e2e harness. The zone-sync failure COUNTING LOGIC
// is extracted into a pure helper function `shouldReportZoneSyncFailure` that
// encapsulates the N-failure threshold decision. This is TDD: the tests encode the
// contract; the implementer adds the function to the new module
// `client/src/ui/zoneSyncGuard.ts` (or wherever they choose) and wires it into
// main.ts's reconcile listener.
//
// RED REASON: `shouldReportZoneSyncFailure` does not exist in any module yet.
// All tests will fail with "does not provide an export named ..." or TypeError
// until the implementer creates the function.
//
// WRONG IMPL KILLED (each test states what it kills):
//   - An impl with threshold=0 is killed by the "0 failures → false" test.
//   - An impl with threshold=1 is killed by the "2 failures → false" test.
//   - An impl that always returns true is killed by the "< threshold → false" suite.
//   - An impl that always returns false is killed by the "≥ threshold → true" suite.
//   - An impl that ignores the threshold param is killed by the custom-threshold tests.

import { describe, expect, it } from 'vitest';
import { shouldReportZoneSyncFailure } from '../ui/zoneSyncGuard';

// ---------------------------------------------------------------------------
// Default threshold (3 — the spec says "N ≥ 3")
// ---------------------------------------------------------------------------
describe('shouldReportZoneSyncFailure: default threshold = 3', () => {
  it('0 consecutive failures → false (zone is fine)', () => {
    // WRONG IMPL KILLED: an impl with threshold=0 that returns true for count=0.
    expect(shouldReportZoneSyncFailure(0)).toBe(false);
  });

  it('1 consecutive failure → false (transient, not yet reportable)', () => {
    // WRONG IMPL KILLED: an impl with threshold=1 that reports too eagerly.
    expect(shouldReportZoneSyncFailure(1)).toBe(false);
  });

  it('2 consecutive failures → false (still below threshold)', () => {
    // WRONG IMPL KILLED: any threshold < 3.
    expect(shouldReportZoneSyncFailure(2)).toBe(false);
  });

  it('3 consecutive failures → true (at threshold — surface the reload message)', () => {
    // This is the exact threshold boundary defined by the spec ("N ≥ 3").
    // WRONG IMPL KILLED: an impl with threshold=4 that misses the ≥3 boundary.
    expect(shouldReportZoneSyncFailure(3)).toBe(true);
  });

  it('10 consecutive failures → true (well past threshold)', () => {
    // Ensures the function does not revert to false after threshold — it stays true.
    // WRONG IMPL KILLED: an impl that only returns true for count===3 (exact match, not ≥).
    expect(shouldReportZoneSyncFailure(10)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Explicit threshold parameter
// The function signature is: shouldReportZoneSyncFailure(count, threshold?)
// where threshold defaults to 3 (the spec minimum).
// ---------------------------------------------------------------------------
describe('shouldReportZoneSyncFailure: explicit threshold parameter', () => {
  it('threshold=1: count=0 → false, count=1 → true', () => {
    // WRONG IMPL KILLED: an impl that ignores the threshold parameter.
    expect(shouldReportZoneSyncFailure(0, 1)).toBe(false);
    expect(shouldReportZoneSyncFailure(1, 1)).toBe(true);
  });

  it('threshold=5: count=4 → false, count=5 → true', () => {
    // WRONG IMPL KILLED: an impl hardcoded to threshold=3 that ignores the arg.
    expect(shouldReportZoneSyncFailure(4, 5)).toBe(false);
    expect(shouldReportZoneSyncFailure(5, 5)).toBe(true);
  });

  it('threshold=3 explicit = same as default', () => {
    // Consistency: explicit threshold=3 must behave identically to the default.
    expect(shouldReportZoneSyncFailure(2, 3)).toBe(false);
    expect(shouldReportZoneSyncFailure(3, 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Boundary / edge cases
// ---------------------------------------------------------------------------
describe('shouldReportZoneSyncFailure: boundary and edge cases', () => {
  it('count === threshold is strictly ≥ (inclusive boundary)', () => {
    // The spec says "after N consecutive failures" — N is inclusive (at or above).
    // WRONG IMPL KILLED: `count > threshold` (strict greater-than) misses the at-threshold case.
    expect(shouldReportZoneSyncFailure(3, 3)).toBe(true);
  });

  it('count = threshold - 1 is the last non-reporting value', () => {
    // Gate that the boundary is tight: threshold-1 must return false.
    // WRONG IMPL KILLED: an off-by-one that returns true at threshold-1.
    expect(shouldReportZoneSyncFailure(2, 3)).toBe(false);
    expect(shouldReportZoneSyncFailure(4, 5)).toBe(false);
  });
});
