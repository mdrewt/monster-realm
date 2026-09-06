// render/placeholderAssets.ts — procedural placeholder textures (M4b).
//
// Real art/spritesheets are a named M4 deferral; these flat, NEUTRALLY-LIT shapes
// stand in behind the AssetProvider seam so the renderer is asset-agnostic and an
// HD-2D upgrade stays additive + render-only (ADR-0004). One texture per
// (action,facing) is cached so an animation swap is a cheap reference change.
//
// Both state axes carry a NON-COLOUR cue (rb-57/ADR-0241): facing is the notch's
// position, action is the glyph's shape. `ACTION_TINT` is redundant reinforcement,
// never the sole carrier -- a player who cannot separate the three tints, or who is
// reading a greyscale capture, can still tell the three actions apart.

import type { Renderer, Texture } from 'pixi.js';
import { Graphics } from 'pixi.js';
import type { WasmAction, WasmDirection } from '../convert/convert';
import { type AnimKey, type AssetProvider, animKey } from './characterView';
import { TILE_PX } from './config';
import { destroyAllTextures } from './textureCache';

const ACTION_TINT: Record<WasmAction, number> = {
  Idle: 0x6fd3a0,
  Walking: 0x4fb3ff,
  Jumping: 0xf2c14e,
};

/** The single dark ink both non-colour cues are drawn in. Shared deliberately:
 *  the glyph must read as a SHAPE difference, not as a second colour code. */
const CUE_INK = 0x10131a;

/** One axis-aligned bar of an action glyph, offset from the TILE CENTRE so the
 *  glyph stays centred if `TILE_PX` changes. */
interface GlyphBar {
  readonly dx: number;
  readonly dy: number;
  readonly w: number;
  readonly h: number;
}

/**
 * The action cue: one bar (Idle, at rest) / two stacked bars (Walking, repeating
 * steps) / a cross (Jumping, lifting off), all in `CUE_INK` (ADR-0241).
 *
 * Constraints these values encode -- change them only against the sibling test:
 * - AXIS-ALIGNED INTEGER RECTS ONLY, no strokes/curves/diagonals. Integer rects
 *   rasterise with no anti-aliasing, and ADR-0160 upscales the stage by a device
 *   INTEGER factor with `nearest`, so the glyph survives every device scale
 *   exactly. A 6px circle or a diagonal would be grey mush before the upscale.
 * - HALF-EXTENT 3 (a 6x6 field), not 4: it leaves 2 clear px against the facing
 *   notch on every side in all four facings. Sized for TILE_PX=32 / body=22.
 * - INVARIANT UNDER A 180-DEGREE ROTATION about the tile centre, so a glyph can
 *   never encode a heading and grow into a second, competing facing cue.
 *
 * `Record<WasmAction, ...>` is load-bearing: a fourth `WasmAction` variant must be
 * a COMPILE ERROR. A `switch` with a `default` would silently ship a colour-only
 * sprite for the new variant -- exactly the defect ADR-0241 closes.
 */
const ACTION_GLYPH: Record<WasmAction, readonly GlyphBar[]> = {
  Idle: [{ dx: -3, dy: -1, w: 6, h: 2 }],
  Walking: [
    { dx: -3, dy: -3, w: 6, h: 2 },
    { dx: -3, dy: 1, w: 6, h: 2 },
  ],
  Jumping: [
    { dx: -3, dy: -1, w: 6, h: 2 },
    { dx: -1, dy: -3, w: 2, h: 6 },
  ],
};

/** Unit offset (tile space) of the facing indicator dot. */
const FACING_NOTCH: Record<WasmDirection, { readonly x: number; readonly y: number }> = {
  North: { x: 0, y: -1 },
  South: { x: 0, y: 1 },
  East: { x: 1, y: 0 },
  West: { x: -1, y: 0 },
};

export class PlaceholderAssets implements AssetProvider {
  readonly #renderer: Renderer;
  readonly #cache = new Map<AnimKey, Texture>();

  constructor(renderer: Renderer) {
    this.#renderer = renderer;
  }

  /**
   * Destroy every cached `generateTexture` result (GPU + base) and empty the
   * cache (#28c). Generated textures are not owned by the stage tree, so
   * `app.destroy(true)` never frees them — the renderer must call this on
   * teardown (and a future real-asset provider swap must, too).
   */
  destroy(): void {
    destroyAllTextures(this.#cache);
  }

  texture(action: WasmAction, facing: WasmDirection): Texture {
    const key = animKey(action, facing);
    const hit = this.#cache.get(key);
    if (hit) return hit;
    const tex = this.#build(action, facing);
    this.#cache.set(key, tex);
    return tex;
  }

  #build(action: WasmAction, facing: WasmDirection): Texture {
    const body = Math.round(TILE_PX * 0.7);
    const inset = Math.round((TILE_PX - body) / 2);
    const g = new Graphics();
    g.roundRect(inset, inset, body, body, 4).fill(ACTION_TINT[action]);
    const n = FACING_NOTCH[facing];
    const centre = TILE_PX / 2;
    const cx = centre + n.x * (body / 2 - 3);
    const cy = centre + n.y * (body / 2 - 3);
    g.circle(cx, cy, 3).fill(CUE_INK);
    // ONE fill for every bar of the glyph: pixi batches consecutive path ops into
    // a single fill instruction, so a per-bar fill would split the glyph across
    // several instructions, and sharing the NOTCH's fill would merge the two cues
    // into one. Its own single fill keeps this purely additive to the draw list.
    for (const bar of ACTION_GLYPH[action]) {
      g.rect(centre + bar.dx, centre + bar.dy, bar.w, bar.h);
    }
    g.fill(CUE_INK);
    // `nearest` (uxd1/ADR-0160): the stage is scaled by a device-INTEGER factor,
    // so bilinear filtering would only blur crisp texel edges. `resolution` stays
    // UNSET (defaults to renderer.resolution = dpr) — pinning it to the device
    // scale would force regenerating this whole cache on every resize.
    const tex = this.#renderer.generateTexture({
      target: g,
      textureSourceOptions: { scaleMode: 'nearest' },
    });
    g.destroy();
    return tex;
  }
}
