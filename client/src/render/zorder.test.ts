// render/zorder.ts behaviour suite (M4b) — vitest + fast-check.
// SOURCE OF TRUTH: M4-frontend.spec.md §3 — overlapping sprites get a STABLE
// z-order (by y / entity_id) so they don't flicker.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compareZ, sortedByZ, type ZItem } from './zorder';

const z = (entityId: bigint, y: number): ZItem => ({ entityId, y });

describe('compareZ / sortedByZ: stable overlap order', () => {
  it('orders by y (depth) first', () => {
    const out = sortedByZ([z(1n, 3), z(2n, 1), z(3n, 2)]);
    expect(out.map((i) => i.y)).toEqual([1, 2, 3]);
  });

  it('breaks y-ties by entity_id (the no-flicker tiebreak)', () => {
    const out = sortedByZ([z(9n, 5), z(2n, 5), z(5n, 5)]);
    expect(out.map((i) => i.entityId)).toEqual([2n, 5n, 9n]);
  });

  it('is input-order-independent: the SAME overlap always paints the same way', () => {
    const a = sortedByZ([z(2n, 5), z(9n, 5), z(5n, 5)]);
    const b = sortedByZ([z(9n, 5), z(5n, 5), z(2n, 5)]);
    expect(a).toEqual(b);
  });

  it('does not mutate its input', () => {
    const input = [z(3n, 1), z(1n, 1)];
    const snapshot = [...input];
    sortedByZ(input);
    expect(input).toEqual(snapshot);
  });

  it('property: compareZ is a total order (antisymmetric + the sort is a permutation)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            entityId: fc.bigInt({ min: 0n, max: 20n }),
            y: fc.integer({ min: 0, max: 5 }),
          }),
          { maxLength: 30 },
        ),
        (raw) => {
          // unique ids so the order is strict
          const seen = new Set<bigint>();
          const items = raw.filter((r) => {
            if (seen.has(r.entityId)) return false;
            seen.add(r.entityId);
            return true;
          });
          const out = sortedByZ(items);
          expect(out.length).toBe(items.length); // a permutation
          for (let i = 1; i < out.length; i++) {
            expect(compareZ(out[i - 1], out[i])).toBeLessThanOrEqual(0); // non-decreasing
            expect(compareZ(out[i], out[i - 1])).toBe(-compareZ(out[i - 1], out[i])); // antisymmetric
          }
        },
      ),
    );
  });
});
