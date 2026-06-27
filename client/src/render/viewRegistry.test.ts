// render/viewRegistry.ts behaviour suite (M4b) — vitest + fast-check.
// SOURCE OF TRUTH: M4-frontend.spec.md §3 — pooled CharacterView per entity
// (never recreate), and "WHEN a character row is deleted ... tear down its
// CharacterView ... no leaked views, no ghost sprite."

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ViewRegistry } from './viewRegistry';

describe('ViewRegistry: pool create/teardown diff', () => {
  it('first sight of an entity is a create; nothing removed', () => {
    const r = new ViewRegistry();
    const { created, removed } = r.reconcile([1n, 2n]);
    expect(created.sort()).toEqual([1n, 2n]);
    expect(removed).toEqual([]);
    expect(r.size).toBe(2);
  });

  it('a stable frame creates and removes nothing (pool reuse, no recreate)', () => {
    const r = new ViewRegistry();
    r.reconcile([1n, 2n]);
    const out = r.reconcile([1n, 2n]);
    expect(out.created).toEqual([]);
    expect(out.removed).toEqual([]);
  });

  it('BITES: a despawned entity is reported removed exactly once (teardown, no ghost)', () => {
    const r = new ViewRegistry();
    r.reconcile([1n, 2n, 3n]);
    const out = r.reconcile([1n, 3n]); // 2n despawned
    expect(out.removed).toEqual([2n]);
    expect(r.has(2n)).toBe(false);
    const again = r.reconcile([1n, 3n]); // already gone — not removed twice
    expect(again.removed).toEqual([]);
  });

  it('handles a churn frame: some created, some removed', () => {
    const r = new ViewRegistry();
    r.reconcile([1n, 2n]);
    const out = r.reconcile([2n, 3n, 4n]);
    expect(out.created.sort()).toEqual([3n, 4n]);
    expect(out.removed).toEqual([1n]);
    expect(r.size).toBe(3);
  });

  it('property: present set always equals the last desired set (no leak, no miss)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.bigInt({ min: 0n, max: 12n }), { maxLength: 12 }), { maxLength: 20 }),
        (frames) => {
          const r = new ViewRegistry();
          let last: bigint[] = [];
          for (const f of frames) {
            r.reconcile(f);
            last = f;
          }
          const want = new Set(last);
          expect(r.size).toBe(want.size);
          for (const id of want) expect(r.has(id)).toBe(true);
        },
      ),
    );
  });
});
