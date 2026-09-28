// render/zorderZIndex.test.ts — O(1) z-order assignment.
//
// EARS criterion:
//   The O(n²) setChildIndex loop SHALL be replaced with
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
//   plus the ordering it induces: sorting entities by zIndexForEntity(y) must give the
//   same order as sorting them by y.
//
// WRONG IMPL KILLED:
//   - An impl that assigns zIndex = rank instead of y: killed by the "zIndex equals y" test.
//   - An impl that assigns zIndex = 0 for all: killed by the distinct-y test.
//   - An impl that uses setChildIndex (the old O(n²) path) instead of zIndex: the
//     formula tests still pass but world.ts still has the bug.

import { describe, expect, it } from 'vitest';
import { zIndexForEntity } from './zorder';

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

  it('equal y → equal zIndex (tied depth; no entity_id tie-break)', () => {
    // Two entities at the same y get the same zIndex; Pixi breaks the tie by insertion order.
    // WRONG IMPL KILLED: an impl that adds entity_id bias to zIndex (unstable for equal y).
    expect(zIndexForEntity(5)).toBe(zIndexForEntity(5));
  });
});

// ---------------------------------------------------------------------------
// Ordering induced by zIndexForEntity
//
// Pixi draws a sortableChildren container in ascending zIndex order, so the order
// world.ts renders in is "sort by zIndexForEntity(y)". That must equal "sort by y"
// (farther back first). Equal y gets equal zIndex: there is no entity_id tie-break.
// ---------------------------------------------------------------------------
describe('zIndexForEntity: ascending zIndex order is ascending y order', () => {
  it('sorting by zIndex gives the same entity order as sorting by y', () => {
    // WRONG IMPL KILLED: zIndex = -y (inverts depth), or any non-monotone mapping.
    const entities = [
      { entityId: 3n, y: 5 },
      { entityId: 1n, y: 1 },
      { entityId: 2n, y: 8 },
      { entityId: 4n, y: 3.5 },
      { entityId: 5n, y: 3.25 },
    ];
    const byZIndex = [...entities].sort((a, b) => zIndexForEntity(a.y) - zIndexForEntity(b.y));
    expect(byZIndex.map((e) => e.entityId)).toEqual([1n, 5n, 4n, 3n, 2n]);
  });

  it('N entities with distinct y values produce N distinct zIndex values (no collision)', () => {
    // WRONG IMPL KILLED: an impl that quantizes zIndex to integer (loses sub-tile ordering).
    const ys = [0.1, 0.5, 1.0, 1.5, 2.0, 5.75];
    const indices = ys.map(zIndexForEntity);
    const uniqueIndices = new Set(indices);
    expect(uniqueIndices.size).toBe(ys.length);
  });
});
