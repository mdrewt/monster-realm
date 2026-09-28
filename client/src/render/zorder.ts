// render/zorder.ts — draw order for overlapping sprites. PURE.
//
// world.ts sets `actors.sortableChildren = true` and `sprite.zIndex = zIndexForEntity(y)`:
// lower y is farther back and renders behind. There is NO entity_id tie-break — sprites
// at equal y fall back to Pixi's insertion order (see ledger FINDING-render-z-tiebreak).

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
