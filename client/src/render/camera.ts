// render/camera.ts — FollowCamera (M11c, ADR-0067; per-axis centering uxd1/ADR-0160).
//
// PURE. No side effects, no DOM, no Pixi. Converts tile-space player position
// to a pixel-space camera offset, clamped so the viewport never shows pixels
// outside the map — EXCEPT on an axis where the map is smaller than the viewport,
// where the map is centered instead of pinned top-left.
import { TILE_PX } from './config';

/**
 * One axis of the camera offset, in SOURCE px. The axes are computed
 * INDEPENDENTLY: a wide-but-short map scrolls horizontally while centering
 * vertically, which a single combined "does the map fit" condition gets wrong.
 *
 * `>=` (not `>`) on the scroll test: at `mapPx === view` both branches are
 * mathematically 0, but the center branch produces `-0`, and `Object.is(-0, 0)`
 * is false — the exactly-fits case belongs to the scroll branch.
 */
function axisOffset(playerTile: number, view: number, mapTiles: number): number {
  const mapPx = mapTiles * TILE_PX;
  if (mapPx >= view) {
    // SCROLL-CLAMP: follow the player, but never past either map edge.
    // +0.5 shifts anchor to tile center (M12.5d-4: tile-corner was a half-tile visual bias).
    const raw = (playerTile + 0.5) * TILE_PX - view / 2;
    return Math.max(0, Math.min(raw, mapPx - view));
  }
  // CENTER: the map is smaller than the viewport on this axis, so the player is
  // NOT tracked here — a negative offset leaves an equal margin on both sides.
  return -(view - mapPx) / 2;
}

export class FollowCamera {
  /**
   * The camera offset in SOURCE px for a player tile.
   *
   * CONTRACT: `viewW`/`viewH` are the EFFECTIVE viewport in SOURCE pixels
   * (`cssPx / stageScale`, i.e. `ViewportScale.effectiveW/H`), NOT CSS pixels.
   * Passing CSS px here is the mixed-unit bug — it misses the viewport center by
   * `cssW/2 * (stageScale - 1)` and collapses the edge clamp.
   */
  offsetFor(
    playerTileX: number,
    playerTileY: number,
    viewW: number,
    viewH: number,
    mapWidthTiles: number,
    mapHeightTiles: number,
  ): { x: number; y: number } {
    return {
      x: axisOffset(playerTileX, viewW, mapWidthTiles),
      y: axisOffset(playerTileY, viewH, mapHeightTiles),
    };
  }
}
