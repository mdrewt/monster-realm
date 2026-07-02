// net/warpDetect.ts — pure warp-detection predicate (M11c, ADR-0067).
//
// PURE. No side effects. Extracted from connection.ts so it can be unit-tested
// without the SpacetimeDB SDK. isOwnZoneChange is the sole place that decides
// whether an onUpdate callback represents the local player crossing a zone warp.

interface MinCharRow {
  entityId: bigint;
  zoneId: number;
}

/** Returns true iff the row update represents the own entity crossing a zone
 *  boundary (newRow.entityId === ownEntityId AND newRow.zoneId !== oldRow.zoneId).
 *
 *  Bigint identity check is strict (`===`) — never lossy via Number() cast. */
export function isOwnZoneChange(
  oldRow: MinCharRow,
  newRow: MinCharRow,
  ownEntityId: bigint,
): boolean {
  return newRow.entityId === ownEntityId && newRow.zoneId !== oldRow.zoneId;
}
