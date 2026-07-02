// net/warpDetect.test.ts — isOwnZoneChange pure-predicate unit tests (M11c).
//
// SOURCE OF TRUTH: M11c EARS C4 — warp detection.
// `isOwnZoneChange(oldRow, newRow, ownEntityId)` is a pure predicate extracted
// from the connection.ts onUpdate callback per ADR-0067 Option C.
//
// RED REASON: `warpDetect.ts` does not exist yet. Every import will fail to
// compile until the implementer creates `client/src/net/warpDetect.ts` and
// exports `isOwnZoneChange(oldRow, newRow, ownEntityId: bigint): boolean`.
//
// Why this is testable without the SDK: the predicate is pure — no DbConnection,
// no subscription, no side effects. It only inspects two row objects and a bigint.
// It is extracted to warpDetect.ts specifically so it can be tested here.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isOwnZoneChange } from './warpDetect';

// ---------------------------------------------------------------------------
// Row shape mirrors the SpacetimeDB Character table binding.
// The predicate only needs entityId: bigint and zoneId: number.
// ---------------------------------------------------------------------------

interface CharRow {
  entityId: bigint;
  zoneId: number;
  tileX: number;
  tileY: number;
}

function makeRow(entityId: bigint, zoneId: number): CharRow {
  return { entityId, zoneId, tileX: 0, tileY: 0 };
}

// ---------------------------------------------------------------------------
// True-positive: own entity, zone changed
// ---------------------------------------------------------------------------

describe('isOwnZoneChange: returns true when own entity changes zone', () => {
  it('BITES: own entity moving from zone 0 to zone 1 → true', () => {
    // Kills: a stub returning false always.
    const ownId = 1n;
    expect(isOwnZoneChange(makeRow(ownId, 0), makeRow(ownId, 1), ownId)).toBe(true);
  });

  it('BITES: own entity moving from zone 1 back to zone 0 → true (bidirectional)', () => {
    // Kills: an impl that only detects forward zone transitions (zoneId increasing).
    const ownId = 42n;
    expect(isOwnZoneChange(makeRow(ownId, 1), makeRow(ownId, 0), ownId)).toBe(true);
  });

  it('BITES: own entity moving to any different zone → true', () => {
    // Kills: an impl hard-coded to only detect zone 0 → 1 transition.
    const ownId = 7n;
    expect(isOwnZoneChange(makeRow(ownId, 2), makeRow(ownId, 5), ownId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// True-negative: zone unchanged
// ---------------------------------------------------------------------------

describe('isOwnZoneChange: returns false when own entity stays in same zone', () => {
  it('BITES: own entity updates tileX/tileY but stays in zone 0 → false', () => {
    // Kills: an impl that returns true on any onUpdate for own entity.
    const ownId = 1n;
    const old = { entityId: ownId, zoneId: 0, tileX: 3, tileY: 4 };
    const next = { entityId: ownId, zoneId: 0, tileX: 4, tileY: 4 };
    expect(isOwnZoneChange(old, next, ownId)).toBe(false);
  });

  it('BITES: no-op update (identical row) → false', () => {
    // Kills: an impl that returns true when the row is dirty at all.
    const ownId = 5n;
    const row = makeRow(ownId, 0);
    expect(isOwnZoneChange(row, row, ownId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// True-negative: other entity (not own)
// ---------------------------------------------------------------------------

describe('isOwnZoneChange: returns false when update is for another entity', () => {
  it('BITES: another entity changes zone → false (not the own entity warping)', () => {
    // Kills: an impl that returns true on any zoneId change regardless of entity.
    const ownId = 1n;
    const otherId = 2n;
    expect(isOwnZoneChange(makeRow(otherId, 0), makeRow(otherId, 1), ownId)).toBe(false);
  });

  it('BITES: another entity stays in same zone → false', () => {
    // Kills: an impl that compares zones but ignores entity identity.
    const ownId = 1n;
    const otherId = 99n;
    expect(isOwnZoneChange(makeRow(otherId, 0), makeRow(otherId, 0), ownId)).toBe(false);
  });

  it('BITES: entityId 0n is NOT ownId when ownId is 1n → false', () => {
    // Kills: an impl that uses `==` (coercive) instead of `===` with bigint.
    const ownId = 1n;
    expect(isOwnZoneChange(makeRow(0n, 0), makeRow(0n, 1), ownId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mixed: entity identity check is strict bigint equality
// ---------------------------------------------------------------------------

describe('isOwnZoneChange: bigint identity check is strict', () => {
  it('BITES: large entityId — own entity zone change detected', () => {
    // Kills: an impl that loses precision with Number() cast for large bigint ids.
    const ownId = 9007199254740993n; // > Number.MAX_SAFE_INTEGER
    expect(isOwnZoneChange(makeRow(ownId, 0), makeRow(ownId, 1), ownId)).toBe(true);
  });

  it('BITES: large entityId — other entity zone change not detected', () => {
    // Kills: an impl that truncates bigints and confuses two high-value ids.
    const ownId = 9007199254740993n;
    const otherId = 9007199254740994n;
    expect(isOwnZoneChange(makeRow(otherId, 0), makeRow(otherId, 1), ownId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Property: the predicate is equivalent to the two-clause spec
// ---------------------------------------------------------------------------

describe('isOwnZoneChange property: matches spec predicate exactly', () => {
  it('BITES: for any rows and any ownId, result equals (entityId===own && zoneId changed)', () => {
    // Kills: any impl that diverges from the two-clause contract.
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1000n }),
        fc.bigInt({ min: 0n, max: 1000n }),
        fc.integer({ min: 0, max: 9 }),
        fc.integer({ min: 0, max: 9 }),
        fc.bigInt({ min: 0n, max: 1000n }),
        (oldEntityId, newEntityId, oldZoneId, newZoneId, ownId) => {
          const oldRow = makeRow(oldEntityId, oldZoneId);
          const newRow = makeRow(newEntityId, newZoneId);
          const expected = newRow.entityId === ownId && newRow.zoneId !== oldRow.zoneId;
          expect(isOwnZoneChange(oldRow, newRow, ownId)).toBe(expected);
        },
      ),
    );
  });
});
