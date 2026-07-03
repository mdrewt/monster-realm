// render/camera.ts — FollowCamera (M11c, ADR-0067).
//
// PURE. No side effects, no DOM, no Pixi. Converts tile-space player position
// to a pixel-space camera offset, clamped so the viewport never shows pixels
// outside the map.
import { TILE_PX } from './config';

export class FollowCamera {
  offsetFor(
    playerTileX: number,
    playerTileY: number,
    viewW: number,
    viewH: number,
    mapWidthTiles: number,
    mapHeightTiles: number,
  ): { x: number; y: number } {
    const maxX = Math.max(0, mapWidthTiles * TILE_PX - viewW);
    const maxY = Math.max(0, mapHeightTiles * TILE_PX - viewH);
    // +0.5 shifts anchor to tile center (M12.5d-4: tile-corner was a half-tile visual bias).
    const rawX = (playerTileX + 0.5) * TILE_PX - viewW / 2;
    const rawY = (playerTileY + 0.5) * TILE_PX - viewH / 2;
    return {
      x: Math.max(0, Math.min(rawX, maxX)),
      y: Math.max(0, Math.min(rawY, maxY)),
    };
  }
}
