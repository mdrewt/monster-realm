// render/zorder.ts — stable draw order for overlapping sprites (M4b). PURE.
//
// "WHEN two characters occupy the same tile THE SYSTEM SHALL draw them in a STABLE
// z-order (e.g. by entity_id / y) so overlapping sprites don't flicker." We sort
// by y first (lower y is farther/behind), breaking ties by entity_id — a total,
// input-order-independent order, so the same overlap always paints the same way.

export interface ZItem {
  readonly entityId: bigint;
  readonly y: number; // animated sub-tile y (depth)
}

/** Total comparator: y ascending, then entity_id ascending (the stable tiebreak). */
export function compareZ(a: ZItem, b: ZItem): number {
  if (a.y !== b.y) return a.y - b.y;
  if (a.entityId === b.entityId) return 0;
  return a.entityId < b.entityId ? -1 : 1;
}

/** A new array of `items` in stable z-order (never mutates the input). */
export function sortedByZ<T extends ZItem>(items: readonly T[]): T[] {
  return [...items].sort(compareZ);
}

/**
 * Maps an entity's fractional tile y-position to its Pixi zIndex value.
 *
 * WHY identity: Pixi sorts `sortableChildren` containers by `sprite.zIndex` in
 * ascending order — lower zIndex is drawn first (behind). Tile-y increases
 * downward, so a higher y-value means "in front". Passing y directly as zIndex
 * keeps the visual and logical orderings aligned without a separate sort step.
 */
export function zIndexForEntity(y: number): number {
  return y;
}
