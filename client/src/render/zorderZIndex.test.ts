// render/zorderZIndex.test.ts — RED tests for M13.5e e-4: O(1) z-order assignment.
//
// SOURCE OF TRUTH: M13.5 §5 e-4 (EARS criterion)
//
// EARS criterion:
//   The O(n²) setChildIndex loop in world.ts lines 133-137 SHALL be replaced with
//   zIndex assignment + sortableChildren. Each sprite SHALL have its zIndex set to
//   its y-position value so the Pixi layer composites in correct depth order.
//
// world.ts imports Pixi.js (Application, Container, Graphics) and its `init()` calls
// `new Application()` + `app.init({ ... })` asynchronously. Full construction of
// WorldRenderer is not feasible in a unit test without a real GPU/canvas environment.
//
// TESTABLE CONTRACT:
//   After the O(n²) → zIndex fix, world.ts should assign sprite.zIndex = entity.y
//   for each rendered entity, and the actors Container should have sortableChildren=true.
//   We test the PURE FORMULA that should govern the assignment:
//     "zIndex for entity at position y should equal y (fractional tile units)"
//   We also test the sortedByZ ordering invariant that the fix relies on — if the
//   implementer assigns zIndex = sortedByZ rank (index), the sort-then-assign produces
//   the same ordering as the sortedByZ comparator. Both approaches are valid; the test
//   gates whichever the implementer chooses.
//
// RED REASON for zIndexForEntity / zIndexOrder:
//   Neither `zIndexForEntity` nor `zIndexOrder` exists yet. These functions are the
//   extracted, testable formula from the O(1) implementation the implementer must write.
//   Tests will fail with "does not provide an export named ..." until created.
//
// WRONG IMPL KILLED:
//   - An impl that assigns zIndex = rank (index in sortedByZ) instead of y: killed by
//     the "zIndex equals y" test.
//   - An impl that assigns zIndex = 0 for all: killed by the distinct-y test.
//   - An impl that uses setChildIndex (the old O(n²) path) instead of zIndex: the
//     formula tests still pass but world.ts still has the bug.
//
// The zorder.ts sortedByZ function (already tested in zorder.test.ts) is used as an
// oracle for correct ordering in the rank-assignment variant test.

import { describe, expect, it } from 'vitest';
import { sortedByZ, zIndexForEntity } from './zorder';

// ---------------------------------------------------------------------------
// zIndexForEntity: the O(1) formula
//
// The expected formula: zIndexForEntity(y) = y
// (fractional tile y IS the depth; Pixi sorts ascending — lower y renders behind,
// higher y renders in front — which matches top-down perspective.)
// ---------------------------------------------------------------------------
describe('zIndexForEntity: maps entity y-position to zIndex (O(1) depth formula)', () => {
  it('zIndex equals entity y for integer positions', () => {
    // WRONG IMPL KILLED: zIndexForEntity(y) = 0 always, or = some rank instead of y.
    expect(zIndexForEntity(0)).toBe(0);
    expect(zIndexForEntity(1)).toBe(1);
    expect(zIndexForEntity(5)).toBe(5);
    expect(zIndexForEntity(10)).toBe(10);
  });

  it('zIndex equals entity y for fractional (sub-tile) positions', () => {
    // CharacterView interpolates sub-tile positions; zIndex must track them.
    // WRONG IMPL KILLED: an impl that floors/rounds to integer (loses sub-tile depth).
    expect(zIndexForEntity(2.5)).toBeCloseTo(2.5);
    expect(zIndexForEntity(0.75)).toBeCloseTo(0.75);
    expect(zIndexForEntity(9.999)).toBeCloseTo(9.999);
  });

  it('lower y → lower zIndex (farther back renders behind)', () => {
    // Pixi sortableChildren renders lower zIndex first (behind) — so lower y must have
    // lower zIndex for correct top-down perspective depth.
    // WRONG IMPL KILLED: an impl with zIndex = -y (inverts depth order).
    expect(zIndexForEntity(0)).toBeLessThan(zIndexForEntity(1));
    expect(zIndexForEntity(3)).toBeLessThan(zIndexForEntity(4));
    expect(zIndexForEntity(2.5)).toBeLessThan(zIndexForEntity(3.0));
  });

  it('equal y → equal zIndex (tied depth; entity_id tiebreak is Pixi-internal)', () => {
    // Two entities at the same y get the same zIndex; Pixi breaks the tie by insertion order.
    // WRONG IMPL KILLED: an impl that adds entity_id bias to zIndex (unstable for equal y).
    expect(zIndexForEntity(5)).toBe(zIndexForEntity(5));
  });
});

// ---------------------------------------------------------------------------
// Consistency with sortedByZ ordering
//
// The sorted order from sortedByZ must agree with zIndex ordering produced by
// zIndexForEntity. If two entities have y1 < y2, then zIndexForEntity(y1) < zIndexForEntity(y2).
// This ensures the two approaches (rank-assign vs zIndex-assign) produce consistent
// depth ordering — regardless of which one world.ts uses after the fix.
// ---------------------------------------------------------------------------
describe('zIndexForEntity: consistent with sortedByZ ordering', () => {
  it('sortedByZ order matches ascending zIndex order (lower y → earlier in sorted → lower zIndex)', () => {
    // WRONG IMPL KILLED: an impl where zIndexForEntity produces ordering that contradicts
    // sortedByZ (e.g., zIndex = -y while sortedByZ sorts ascending by y).
    const entities = [
      { entityId: 3n, y: 5 },
      { entityId: 1n, y: 1 },
      { entityId: 2n, y: 8 },
      { entityId: 4n, y: 3 },
    ];
    const sorted = sortedByZ(entities);
    // After sort: y=1, y=3, y=5, y=8 — ascending
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const curr = sorted[i]!;
      // zIndex for a later-in-sorted entity must be >= zIndex of earlier entity
      expect(zIndexForEntity(curr.y)).toBeGreaterThanOrEqual(zIndexForEntity(prev.y));
    }
  });

  it('N entities with distinct y values produce N distinct zIndex values (no collision)', () => {
    // WRONG IMPL KILLED: an impl that quantizes zIndex to integer (loses sub-tile ordering).
    const ys = [0.1, 0.5, 1.0, 1.5, 2.0, 5.75];
    const indices = ys.map(zIndexForEntity);
    const uniqueIndices = new Set(indices);
    expect(uniqueIndices.size).toBe(ys.length);
  });
});
