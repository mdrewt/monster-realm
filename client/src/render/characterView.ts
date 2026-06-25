// render/characterView.ts — one POOLED sprite per entity (M4b, ADR-0004).
//
// Imperative shell (no pixel tests — the renderer is validated by the M5 e2e via
// `window.__game()`; its LOGIC lives in the tested pure modules). A CharacterView
// wraps ONE Pixi sprite, mutated in place every frame (never recreated — the v1
// "recreate-Pixi" pitfall), swapping its texture set ONLY when the (action,facing)
// animation key actually changes.
import { Sprite } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { WasmAction, WasmDirection } from '../convert/convert';
import { TILE_PX } from './config';

export type AnimKey = `${WasmAction}:${WasmDirection}`;

export function animKey(action: WasmAction, facing: WasmDirection): AnimKey {
  return `${action}:${facing}`;
}

/**
 * The renderer's asset seam (ADR-0004 HD-2D readiness). A sprite is an "albedo"
 * texture today; a later provider can additionally supply normal/material channels
 * for a lighting/post-processing render mode — an ADDITIVE change behind this same
 * interface, `render/`-only. Assets are authored NEUTRALLY-LIT (no baked
 * directional shadows) so they are normal-map-ready.
 */
export interface AssetProvider {
  texture(action: WasmAction, facing: WasmDirection): Texture;
}

export class CharacterView {
  readonly sprite: Sprite;
  readonly #assets: AssetProvider;
  #key: AnimKey | undefined;

  constructor(assets: AssetProvider) {
    this.#assets = assets;
    this.sprite = new Sprite();
    this.sprite.anchor.set(0.5, 0.5);
  }

  /** Mutate-in-place: place at a FRACTIONAL tile position (sub-tile is render-only,
   *  never stored/sent) and swap the texture set only on an animation-key change. */
  update(tileX: number, tileY: number, action: WasmAction, facing: WasmDirection): void {
    this.sprite.x = (tileX + 0.5) * TILE_PX;
    this.sprite.y = (tileY + 0.5) * TILE_PX;
    const key = animKey(action, facing);
    if (key !== this.#key) {
      this.sprite.texture = this.#assets.texture(action, facing);
      this.#key = key;
    }
  }

  destroy(): void {
    this.sprite.destroy();
  }
}
