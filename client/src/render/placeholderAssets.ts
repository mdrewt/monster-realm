// render/placeholderAssets.ts — procedural placeholder textures (M4b).
//
// Real art/spritesheets are a named M4 deferral; these flat, NEUTRALLY-LIT shapes
// stand in behind the AssetProvider seam so the renderer is asset-agnostic and an
// HD-2D upgrade stays additive + render-only (ADR-0004). One texture per
// (action,facing) is cached so an animation swap is a cheap reference change.

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
    const cx = TILE_PX / 2 + n.x * (body / 2 - 3);
    const cy = TILE_PX / 2 + n.y * (body / 2 - 3);
    g.circle(cx, cy, 3).fill(0x10131a);
    const tex = this.#renderer.generateTexture(g);
    g.destroy();
    return tex;
  }
}
